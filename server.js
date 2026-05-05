const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
const TZ = 'Europe/Istanbul';
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'json')).toLowerCase();
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'dev')).toLowerCase();
const EMAIL_FROM = process.env.EMAIL_FROM || 'No Contact Challenge <onboarding@example.com>';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 262144);
const REQUIRED_PRODUCTION_ENV = ['APP_URL', 'ADMIN_PASSWORD'];
let dataCache = null;
let pgPool = null;
let pendingStorageWrite = Promise.resolve();

function todayKey(offsetDays = 0) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const base = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offsetDays));
  return base.toISOString().slice(0, 10);
}

function addDays(dateKey, offset) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + offset));
  return date.toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomBytes(12).toString('hex');
}

const SESSION_COOKIE = 'ncc_session';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 160);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.passwordSalt || !user.passwordHash) return false;
  const calculated = hashPassword(password, user.passwordSalt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(user.passwordHash, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}

function setSessionCookie(res, token) {
  const secure = IS_PRODUCTION ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}


const rateLimitBuckets = new Map();
function clientKey(req) {
  const forwarded = TRUST_PROXY ? req.headers['x-forwarded-for'] : '';
  return String(forwarded || req.socket.remoteAddress || 'local').split(',')[0].trim();
}
function rateLimit(req, key, limit = 20, windowMs = 15 * 60 * 1000) {
  const bucketKey = `${key}:${clientKey(req)}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + windowMs;
  }
  current.count += 1;
  rateLimitBuckets.set(bucketKey, current);
  if (current.count > limit) {
    const err = new Error('Too many attempts. Please wait a few minutes and try again.');
    err.status = 429;
    throw err;
  }
}

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function ensureCsrf(data, session) {
  if (!session.csrfToken) session.csrfToken = uid() + uid();
  return session.csrfToken;
}

function getSession(data, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return data.sessions.find(s => s.token === token && (!s.expiresAt || new Date(s.expiresAt) > new Date())) || null;
}

function requireCsrf(data, req) {
  const session = getSession(data, req);
  if (!session) return;
  const expected = ensureCsrf(data, session);
  const supplied = req.headers['x-csrf-token'];
  if (!supplied || supplied !== expected) {
    const err = new Error('Security token expired. Refresh the page and try again.');
    err.status = 403;
    throw err;
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}

function defaultPrivacy() {
  return {
    showInCommunity: true,
    showStreak: true,
    showLastCheckin: true,
    showMilestones: true,
    showMood: false,
    allowEncouragements: true
  };
}

function normalizePrivacy(privacy) {
  const defaults = defaultPrivacy();
  const source = privacy && typeof privacy === 'object' ? privacy : {};
  return Object.fromEntries(Object.keys(defaults).map(key => [key, typeof source[key] === 'boolean' ? source[key] : defaults[key]]));
}

function normalizeProfile(profile, username = '') {
  const p = profile && typeof profile === 'object' ? profile : {};
  const colors = ['sage', 'blue', 'amber', 'rose', 'stone', 'violet', 'teal'];
  const avatarColor = colors.includes(p.avatarColor) ? p.avatarColor : 'sage';
  return {
    displayName: cleanText(p.displayName || username || 'Member', 40),
    bio: cleanText(p.bio || '', 160),
    avatarColor,
    anonymousMode: Boolean(p.anonymousMode)
  };
}

function publicDisplayName(user) {
  const profile = normalizeProfile(user.profile, user.username);
  if (profile.anonymousMode) return 'Anonymous Member';
  return profile.displayName || user.username;
}

function postJsonHttps(hostname, pathName, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw ? JSON.parse(raw) : {});
        } else {
          reject(new Error(`Email provider returned ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deliverEmail(message) {
  if (EMAIL_PROVIDER === 'resend') {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is missing.');
    const response = await postJsonHttps('api.resend.com', '/emails', {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`
    }, {
      from: EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text
    });
    return { provider: 'resend', providerId: response.id || null };
  }
  return { provider: 'dev', providerId: null };
}

function queueEmailDelivery(data, message) {
  if (EMAIL_PROVIDER === 'dev') {
    console.log(`\n[DEV EMAIL:${message.type}] To: ${message.to}\nSubject: ${message.subject}\n${message.text}\n`);
    return;
  }
  deliverEmail(message)
    .then(result => {
      message.status = 'sent';
      message.provider = result.provider;
      message.providerId = result.providerId;
      message.sentAt = new Date().toISOString();
      writeData(data);
    })
    .catch(err => {
      message.status = 'failed';
      message.error = err.message;
      message.failedAt = new Date().toISOString();
      console.error('[EMAIL ERROR]', err.message);
      writeData(data);
    });
}

function createEmail(data, to, subject, text, type = 'general') {
  const message = {
    id: uid(), to, subject, text, type,
    createdAt: new Date().toISOString(),
    status: EMAIL_PROVIDER === 'dev' ? 'dev-outbox' : 'queued',
    provider: EMAIL_PROVIDER
  };
  data.emailOutbox.push(message);
  if (data.emailOutbox.length > 500) data.emailOutbox = data.emailOutbox.slice(-500);
  queueEmailDelivery(data, message);
  return message;
}

function createEmailVerificationToken(data, user) {
  data.emailVerificationTokens = data.emailVerificationTokens.filter(t => t.userId !== user.id && !t.used);
  const token = uid() + uid();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  data.emailVerificationTokens.push({ token, userId: user.id, email: user.email, createdAt: new Date().toISOString(), expiresAt, used: false });
  createEmail(data, user.email, 'Verify your No Contact Challenge account', `Verify your email here: ${APP_URL}/?verify=${token}\n\nOr paste this token into the app: ${token}`, 'email_verification');
  return token;
}

function verifyEmailToken(data, token) {
  const record = data.emailVerificationTokens.find(t => t.token === String(token || '') && !t.used && (!t.expiresAt || new Date(t.expiresAt) > new Date()));
  if (!record) { const err = new Error('Verification token is invalid or expired.'); err.status = 400; throw err; }
  const user = findUserById(data, record.userId);
  if (!user) { const err = new Error('Account not found.'); err.status = 404; throw err; }
  user.emailVerified = true;
  record.used = true;
  user.updatedAt = new Date().toISOString();
  return user;
}

function resourcesLibrary() {
  return [
    { id: 'miss-them', category: 'Urges', title: 'What to do when you miss them', minutes: 4, body: 'Missing someone is not proof that you should contact them. It is a wave. Delay action, breathe, reread your reasons, and choose one grounding action.' },
    { id: 'profile-checking', category: 'Digital boundaries', title: 'How to stop checking their profile', minutes: 5, body: 'Remove shortcuts, mute mutual triggers, and replace the checking loop with a 20-minute pause. The goal is not perfection; it is interrupting the habit.' },
    { id: 'lonely-nights', category: 'Loneliness', title: 'How to survive lonely nights', minutes: 4, body: 'Night can amplify longing. Prepare a low-effort plan before the urge appears: shower, tea, message a safe friend, journal, and sleep.' },
    { id: 'relapse', category: 'Reset', title: 'What to do after a relapse', minutes: 3, body: 'A slip is information, not identity. Name the trigger, repair your environment, and restart without turning guilt into more contact.' },
    { id: 'romanticizing', category: 'Clarity', title: 'How to stop romanticizing the past', minutes: 5, body: 'Your mind may replay the good parts only. Balance the memory by writing what hurt, what changed, and what peace requires now.' }
  ];
}

function healingPlan() {
  return [
    { day: 1, title: 'Why no-contact matters', action: 'Write three reasons you are choosing peace today.' },
    { day: 3, title: 'Handling urges', action: 'Use the urge button once even if the urge is mild.' },
    { day: 7, title: 'Rebuilding your routine', action: 'Choose one evening habit that does not involve checking them.' },
    { day: 14, title: 'Emotional detox', action: 'Notice what feels calmer and what still triggers you.' },
    { day: 30, title: 'New identity', action: 'Write who you are becoming without this attachment cycle.' },
    { day: 60, title: 'Deep reset', action: 'Review your message graveyard and celebrate what you did not send.' },
    { day: 90, title: 'Future self', action: 'Create a personal boundary promise for the next chapter.' }
  ];
}

function userPlanPayload(data, user) {
  const streak = calculateStreak(data, user.id);
  const done = new Set(data.planProgress.filter(p => p.userId === user.id).map(p => p.stepDay));
  return healingPlan().map(step => ({ ...step, unlocked: streak >= step.day, completed: done.has(step.day) }));
}

function analyticsPayload(data) {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = addDays(todayKey(), -i);
    days.push({
      date,
      checkins: data.checkins.filter(c => c.date === date).length,
      reflections: data.checkins.filter(c => c.date === date && c.reflection).length,
      relapses: data.relapseLogs.filter(r => r.date === date).length,
      encouragements: data.encouragements.filter(e => e.date === date).length,
      urges: data.urgeLogs.filter(u => String(u.createdAt || '').slice(0, 10) === date).length
    });
  }
  const verifiedUsers = data.users.filter(u => u.emailVerified).length;
  const openReports = data.reports.filter(r => r.status !== 'resolved').length;
  return { days, verifiedUsers, openReports, emailOutbox: data.emailOutbox.length, resourceViews: data.resourceViews.length };
}

function emptyData() {
  return {
    users: [],
    checkins: [],
    urgeLogs: [],
    reasons: [],
    messageGraveyard: [],
    relapseLogs: [],
    encouragements: [],
    adminActions: [],
    sessions: [],
    passwordResetTokens: [],
    emailVerificationTokens: [],
    emailOutbox: [],
    reports: [],
    resourceViews: [],
    planProgress: []
  };
}

function normalizeData(data) {
  const clean = data && typeof data === 'object' ? data : emptyData();
  if (!Array.isArray(clean.users)) clean.users = [];
  if (!Array.isArray(clean.checkins)) clean.checkins = [];
  if (!Array.isArray(clean.urgeLogs)) clean.urgeLogs = [];
  if (!Array.isArray(clean.reasons)) clean.reasons = [];
  if (!Array.isArray(clean.messageGraveyard)) clean.messageGraveyard = [];
  if (!Array.isArray(clean.relapseLogs)) clean.relapseLogs = [];
  if (!Array.isArray(clean.encouragements)) clean.encouragements = [];
  if (!Array.isArray(clean.adminActions)) clean.adminActions = [];
  if (!Array.isArray(clean.sessions)) clean.sessions = [];
  if (!Array.isArray(clean.passwordResetTokens)) clean.passwordResetTokens = [];
  if (!Array.isArray(clean.emailVerificationTokens)) clean.emailVerificationTokens = [];
  if (!Array.isArray(clean.emailOutbox)) clean.emailOutbox = [];
  if (!Array.isArray(clean.reports)) clean.reports = [];
  if (!Array.isArray(clean.resourceViews)) clean.resourceViews = [];
  if (!Array.isArray(clean.planProgress)) clean.planProgress = [];
  clean.users.forEach(user => {
    user.privacy = normalizePrivacy(user.privacy);
    if (typeof user.hidden !== 'boolean') user.hidden = false;
    if (!user.usernameLower) user.usernameLower = String(user.username || '').toLowerCase();
    if (user.email && !user.emailLower) user.emailLower = normalizeEmail(user.email);
    if (typeof user.emailVerified !== 'boolean') user.emailVerified = false;
    user.profile = normalizeProfile(user.profile, user.username);
  });
  clean.emailVerificationTokens = clean.emailVerificationTokens.filter(t => t && t.token && t.userId && (!t.expiresAt || new Date(t.expiresAt) > new Date()) && !t.used);
  clean.sessions = clean.sessions.filter(sess => sess && sess.token && sess.userId && (!sess.expiresAt || new Date(sess.expiresAt) > new Date()));
  clean.passwordResetTokens = clean.passwordResetTokens.filter(t => t && t.token && t.userId && (!t.expiresAt || new Date(t.expiresAt) > new Date()));
  return clean;
}

function readJsonData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = seedData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  try {
    return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (err) {
    console.error('Could not read data file:', err);
    return emptyData();
  }
}

function readData() {
  if (!dataCache) dataCache = readJsonData();
  return normalizeData(dataCache);
}

function writeData(data) {
  dataCache = normalizeData(data);
  if (STORAGE_DRIVER === 'postgres' && pgPool) {
    const snapshot = JSON.stringify(dataCache);
    pendingStorageWrite = pendingStorageWrite
      .then(() => pgPool.query(
        `insert into app_state (id, data, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        ['main', snapshot]
      ))
      .catch(err => console.error('[POSTGRES WRITE ERROR]', err.message));
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(dataCache, null, 2));
}

async function initStorage() {
  if (STORAGE_DRIVER === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when STORAGE_DRIVER=postgres.');
    let pg;
    try {
      pg = require('pg');
    } catch (err) {
      throw new Error('PostgreSQL mode needs the pg package. Run: npm install');
    }
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
    });
    await pgPool.query(`create table if not exists app_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )`);
    const result = await pgPool.query('select data from app_state where id = $1', ['main']);
    if (result.rows[0]) {
      dataCache = normalizeData(result.rows[0].data);
    } else {
      dataCache = readJsonData();
      await pgPool.query('insert into app_state (id, data) values ($1, $2::jsonb)', ['main', JSON.stringify(dataCache)]);
    }
    console.log('Storage: PostgreSQL app_state JSONB');
    return;
  }
  dataCache = readJsonData();
  console.log('Storage: local data.json');
}

function seedData() {
  return emptyData();
}


function findUserByEmail(data, email) {
  const clean = normalizeEmail(email);
  if (!clean) return null;
  return data.users.find(u => u.emailLower === clean) || null;
}

function publicAccount(user) {
  return user ? { id: user.id, username: user.username, email: user.email || '', emailVerified: Boolean(user.emailVerified), profile: normalizeProfile(user.profile, user.username), createdAt: user.createdAt } : null;
}

function createAccount(data, { email, password, username }) {
  const cleanEmail = normalizeEmail(email);
  const cleanUsername = normalizeUsername(username);
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
    const err = new Error('Enter a valid email address.'); err.status = 400; throw err;
  }
  if (String(password || '').length < 8) {
    const err = new Error('Password must be at least 8 characters.'); err.status = 400; throw err;
  }
  if (cleanUsername.length < 2) {
    const err = new Error('Display name must be at least 2 characters.'); err.status = 400; throw err;
  }
  if (!/^[a-zA-Z0-9 _.-]+$/.test(cleanUsername)) {
    const err = new Error('Display name can only contain letters, numbers, spaces, dots, underscores, and hyphens.'); err.status = 400; throw err;
  }
  if (findUserByEmail(data, cleanEmail)) { const err = new Error('An account with this email already exists.'); err.status = 409; throw err; }
  const existingName = getUser(data, cleanUsername);
  if (existingName) { const err = new Error('That display name is already taken.'); err.status = 409; throw err; }
  const { salt, hash } = hashPassword(password);
  const user = {
    id: uid(), username: cleanUsername, usernameLower: cleanUsername.toLowerCase(),
    email: cleanEmail, emailLower: cleanEmail, emailVerified: false, passwordSalt: salt, passwordHash: hash,
    profile: normalizeProfile({ displayName: cleanUsername }, cleanUsername),
    createdAt: new Date().toISOString(), hidden: false, privacy: defaultPrivacy()
  };
  data.users.push(user);
  return user;
}

function createSession(data, user) {
  const token = uid() + uid();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  data.sessions.push({ token, userId: user.id, csrfToken: uid() + uid(), createdAt: new Date().toISOString(), expiresAt });
  return token;
}

function getSessionUser(data, req) {
  const session = getSession(data, req);
  if (!session) return null;
  return findUserById(data, session.userId);
}

function requireUser(data, req) {
  const user = getSessionUser(data, req);
  if (!user) { const err = new Error('Please sign in first.'); err.status = 401; throw err; }
  return user;
}


function createPasswordResetToken(data, user) {
  // Prototype behavior: token is returned in API response for local testing.
  // In production, send this token by email instead of showing it in the browser.
  data.passwordResetTokens = data.passwordResetTokens.filter(t => t.userId !== user.id);
  const token = uid() + uid();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();
  data.passwordResetTokens.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt, used: false });
  return token;
}

function resetPasswordWithToken(data, token, newPassword) {
  const reset = data.passwordResetTokens.find(t => t.token === String(token || '') && !t.used && (!t.expiresAt || new Date(t.expiresAt) > new Date()));
  if (!reset) { const err = new Error('Reset token is invalid or expired.'); err.status = 400; throw err; }
  if (String(newPassword || '').length < 8) { const err = new Error('Password must be at least 8 characters.'); err.status = 400; throw err; }
  const user = findUserById(data, reset.userId);
  if (!user) { const err = new Error('Account not found.'); err.status = 404; throw err; }
  const { salt, hash } = hashPassword(newPassword);
  user.passwordSalt = salt;
  user.passwordHash = hash;
  reset.used = true;
  data.sessions = data.sessions.filter(s => s.userId !== user.id);
  return user;
}

function updateAccountProfile(data, user, body) {
  const cleanUsername = normalizeUsername(body.username || user.username);
  const cleanEmail = normalizeEmail(body.email || user.email);
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) { const err = new Error('Enter a valid email address.'); err.status = 400; throw err; }
  if (cleanUsername.length < 2) { const err = new Error('Display name must be at least 2 characters.'); err.status = 400; throw err; }
  if (!/^[a-zA-Z0-9 _.-]+$/.test(cleanUsername)) { const err = new Error('Display name can only contain letters, numbers, spaces, dots, underscores, and hyphens.'); err.status = 400; throw err; }
  const existingEmail = findUserByEmail(data, cleanEmail);
  if (existingEmail && existingEmail.id !== user.id) { const err = new Error('Another account already uses that email.'); err.status = 409; throw err; }
  const existingName = getUser(data, cleanUsername);
  if (existingName && existingName.id !== user.id) { const err = new Error('That display name is already taken.'); err.status = 409; throw err; }
  user.username = cleanUsername;
  user.usernameLower = cleanUsername.toLowerCase();
  const emailChanged = cleanEmail !== user.emailLower;
  user.email = cleanEmail;
  user.emailLower = cleanEmail;
  if (emailChanged) user.emailVerified = false;
  user.updatedAt = new Date().toISOString();
  return user;
}

function exportUserData(data, user) {
  return {
    exportedAt: new Date().toISOString(),
    account: publicAccount(user),
    privacy: normalizePrivacy(user.privacy),
    checkins: getUserCheckins(data, user.id),
    reasons: getReasons(data, user.id),
    urgeLogs: getUserUrges(data, user.id),
    messageGraveyard: getUserMessages(data, user.id),
    relapseLogs: getUserRelapses(data, user.id),
    encouragementsReceived: data.encouragements.filter(e => e.toUserId === user.id),
    encouragementsSent: data.encouragements.filter(e => e.fromUserId === user.id),
    reportsMade: data.reports.filter(r => r.reporterId === user.id),
    planProgress: data.planProgress.filter(p => p.userId === user.id),
    resourceViews: data.resourceViews.filter(v => v.userId === user.id)
  };
}


function getUser(data, username) {
  const clean = normalizeUsername(username);
  if (!clean) return null;
  return data.users.find(u => u.usernameLower === clean.toLowerCase()) || null;
}

function createUser(data, username) {
  const clean = normalizeUsername(username);
  if (clean.length < 2) {
    const err = new Error('Username must be at least 2 characters.');
    err.status = 400;
    throw err;
  }
  if (!/^[a-zA-Z0-9 _.-]+$/.test(clean)) {
    const err = new Error('Username can only contain letters, numbers, spaces, dots, underscores, and hyphens.');
    err.status = 400;
    throw err;
  }

  const existing = getUser(data, clean);
  if (existing) return existing;

  const user = {
    id: uid(),
    username: clean,
    usernameLower: clean.toLowerCase(),
    createdAt: new Date().toISOString(),
    hidden: false,
    privacy: defaultPrivacy()
  };
  data.users.push(user);
  return user;
}

function getUserDates(data, userId) {
  return data.checkins
    .filter(c => c.userId === userId)
    .map(c => c.date)
    .sort()
    .reverse();
}

function calculateStreak(data, userId) {
  const dateSet = new Set(getUserDates(data, userId));
  const relapseDates = new Set(getUserRelapses(data, userId).map(r => r.date));
  let cursor = todayKey();

  // If the user has not checked in today, current streak should start from yesterday.
  if (!dateSet.has(cursor)) cursor = addDays(cursor, -1);

  let streak = 0;
  while (dateSet.has(cursor) && !relapseDates.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function getLastCheckin(data, userId) {
  const dates = getUserDates(data, userId);
  return dates[0] || null;
}

function getUserCheckins(data, userId) {
  return data.checkins
    .filter(c => c.userId === userId)
    .sort((a, b) => a.date.localeCompare(b.date));
}


function getUserRelapses(data, userId) {
  return data.relapseLogs
    .filter(r => r.userId === userId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function getUserUrges(data, userId) {
  return data.urgeLogs
    .filter(u => u.userId === userId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function getUserMessages(data, userId) {
  return data.messageGraveyard
    .filter(m => m.userId === userId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function getReasons(data, userId) {
  return data.reasons.find(r => r.userId === userId) || null;
}

function getLatestRelapseDate(data, userId) {
  const relapses = getUserRelapses(data, userId).map(r => r.date).sort().reverse();
  return relapses[0] || null;
}

function dailyQuote() {
  const quotes = [
    'You do not need to reopen the wound to prove it hurt.',
    'No contact is not punishment. It is protection for your peace.',
    'A quiet day is still progress.',
    'You can miss someone and still choose yourself.',
    'Your future self is being built by today’s boundary.',
    'The urge will pass. Your dignity can stay.',
    'Healing often feels boring before it feels peaceful.',
    'You are allowed to stop explaining yourself to what hurt you.',
    'One day at a time is still a direction.',
    'Not responding is also a response to your own pain.'
  ];
  const today = todayKey();
  const index = today.split('-').join('').split('').reduce((sum, ch) => sum + Number(ch), 0) % quotes.length;
  return { text: quotes[index], date: today };
}

function encouragementCountFor(data, userId) {
  return data.encouragements.filter(e => e.toUserId === userId).length;
}

function privateDashboardPayload(data, user) {
  const userCheckins = getUserCheckins(data, user.id);
  const urges = getUserUrges(data, user.id);
  const messages = getUserMessages(data, user.id);
  const relapses = getUserRelapses(data, user.id);
  const moods = userCheckins
    .filter(c => c.reflection?.mood)
    .slice(-14)
    .map(c => ({ date: c.date, mood: c.reflection.mood, note: c.reflection.note || '' }));
  const longestStreak = calculateLongestStreak(data, user.id);
  return {
    totalCheckins: userCheckins.length,
    currentStreak: calculateStreak(data, user.id),
    longestStreak,
    reflectionCount: userCheckins.filter(c => c.reflection).length,
    urgeCount: urges.length,
    unsentMessageCount: messages.length,
    relapseCount: relapses.length,
    encouragementsReceived: encouragementCountFor(data, user.id),
    reasons: getReasons(data, user.id),
    recentMoods: moods,
    recentUrges: urges.slice(0, 5).map(u => ({ intensity: u.intensity, note: u.note, createdAt: u.createdAt })),
    recentMessages: messages.slice(0, 5).map(m => ({ id: m.id, title: m.title, message: m.message, createdAt: m.createdAt })),
    recentRelapses: relapses.slice(0, 5).map(r => ({ reason: r.reason, trigger: r.trigger, note: r.note, date: r.date, createdAt: r.createdAt }))
  };
}

function calculateLongestStreak(data, userId) {
  const relapseDates = new Set(getUserRelapses(data, userId).map(r => r.date));
  const dates = [...new Set(getUserDates(data, userId))].sort();
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const date of dates) {
    if (relapseDates.has(date)) {
      current = 0;
      previous = date;
      continue;
    }
    if (!previous || addDays(previous, 1) === date) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
    previous = date;
  }
  return longest;
}

function milestonePayload(streak) {
  const milestones = [
    { days: 1, title: 'I chose myself', emoji: '🌱' },
    { days: 3, title: 'First momentum', emoji: '🪴' },
    { days: 7, title: 'One week strong', emoji: '🌿' },
    { days: 14, title: 'Two weeks clear', emoji: '☀️' },
    { days: 30, title: 'New chapter', emoji: '🏅' },
    { days: 60, title: 'Deep reset', emoji: '💚' },
    { days: 90, title: 'Emotional reset', emoji: '🌳' }
  ];
  return milestones.map(m => ({ ...m, unlocked: streak >= m.days }));
}

function publicMilestones(streak) {
  return milestonePayload(streak).filter(m => m.unlocked);
}

function monthCalendar(data, userId, monthKey) {
  const today = todayKey();
  const wanted = /^\d{4}-\d{2}$/.test(String(monthKey || '')) ? monthKey : today.slice(0, 7);
  const [year, month] = wanted.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = first.getUTCDay();
  const dateMap = new Map(getUserCheckins(data, userId).map(c => [c.date, c]));
  const days = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const key = `${wanted}-${String(i).padStart(2, '0')}`;
    const checkin = dateMap.get(key);
    days.push({
      date: key,
      day: i,
      checked: Boolean(checkin),
      isToday: key === today,
      mood: checkin?.reflection?.mood || '',
      hasReflection: Boolean(checkin?.reflection)
    });
  }
  return { month: wanted, firstWeekday, daysInMonth, days };
}

function userPayload(data, user, monthKey) {
  const today = todayKey();
  const streak = calculateStreak(data, user.id);
  const checkins = getUserCheckins(data, user.id);
  const todayCheckin = checkins.find(c => c.date === today);
  return {
    account: publicAccount(user),
    username: user.username,
    checkedToday: Boolean(todayCheckin),
    currentStreak: streak,
    lastCheckin: getLastCheckin(data, user.id),
    reflectionToday: todayCheckin?.reflection || null,
    checkins: checkins.map(c => ({ date: c.date, mood: c.reflection?.mood || '', hasReflection: Boolean(c.reflection) })),
    calendar: monthCalendar(data, user.id, monthKey),
    milestones: milestonePayload(streak),
    dashboard: privateDashboardPayload(data, user),
    quote: dailyQuote(),
    privacy: normalizePrivacy(user.privacy),
    profile: normalizeProfile(user.profile, user.username),
    emailVerified: Boolean(user.emailVerified),
    healingPlan: userPlanPayload(data, user),
    resources: resourcesLibrary(),
    lastRelapse: getLatestRelapseDate(data, user.id)
  };
}

function labelDate(dateKey) {
  if (!dateKey) return 'Never';
  const today = todayKey();
  const yesterday = addDays(today, -1);
  if (dateKey === today) return 'Today';
  if (dateKey === yesterday) return 'Yesterday';
  return dateKey;
}

function communityPayload(data) {
  const today = todayKey();
  const rows = data.users
    .filter(user => !user.hidden && normalizePrivacy(user.privacy).showInCommunity)
    .map(user => {
      const privacy = normalizePrivacy(user.privacy);
      const checkedToday = data.checkins.some(c => c.userId === user.id && c.date === today);
      const streak = calculateStreak(data, user.id);
      const last = getLastCheckin(data, user.id);
      const todayCheckin = data.checkins.find(c => c.userId === user.id && c.date === today);
      return {
        id: user.id,
        username: publicDisplayName(user),
        realUsername: user.username,
        avatarColor: normalizeProfile(user.profile, user.username).avatarColor,
        bio: normalizeProfile(user.profile, user.username).anonymousMode ? '' : normalizeProfile(user.profile, user.username).bio,
        status: checkedToday ? 'in' : 'pending',
        currentStreak: privacy.showStreak ? streak : null,
        streakHidden: !privacy.showStreak,
        lastCheckin: privacy.showLastCheckin ? last : null,
        lastCheckinLabel: privacy.showLastCheckin ? labelDate(last) : 'Hidden',
        milestones: privacy.showMilestones ? publicMilestones(streak) : [],
        mood: privacy.showMood ? (todayCheckin?.reflection?.mood || '') : '',
        allowEncouragements: privacy.allowEncouragements,
        encouragements: privacy.allowEncouragements ? encouragementCountFor(data, user.id) : null
      };
    }).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
      return (b.currentStreak || 0) - (a.currentStreak || 0);
    });

  const checkedToday = rows.filter(r => r.status === 'in').length;
  const longestStreak = rows.reduce((max, r) => Math.max(max, r.currentStreak || 0), 0);

  return {
    today,
    stats: {
      checkedToday,
      totalMembers: rows.length,
      longestStreak,
      supportScore: 4.8,
      totalCheckins: data.checkins.length,
      reflectionsToday: data.checkins.filter(c => c.date === today && c.reflection).length,
      totalEncouragements: data.encouragements.length
    },
    members: rows
  };
}


const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-admin';

function requireAdmin(req) {
  const supplied = req.headers['x-admin-password'] || '';
  if (String(supplied) !== String(ADMIN_PASSWORD)) {
    const err = new Error('Admin password is incorrect. Set ADMIN_PASSWORD in your environment for production.');
    err.status = 401;
    throw err;
  }
}

function publicAdminUser(data, user) {
  const checkins = getUserCheckins(data, user.id);
  const lastCheckin = getLastCheckin(data, user.id);
  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    emailVerified: Boolean(user.emailVerified),
    profile: normalizeProfile(user.profile, user.username),
    hasPassword: Boolean(user.passwordHash),
    hidden: Boolean(user.hidden),
    createdAt: user.createdAt,
    currentStreak: calculateStreak(data, user.id),
    longestStreak: calculateLongestStreak(data, user.id),
    totalCheckins: checkins.length,
    lastCheckin,
    reflectionCount: checkins.filter(c => c.reflection).length,
    urgeCount: getUserUrges(data, user.id).length,
    messageCount: getUserMessages(data, user.id).length,
    relapseCount: getUserRelapses(data, user.id).length,
    encouragementsReceived: encouragementCountFor(data, user.id),
    reasonsSaved: Boolean(getReasons(data, user.id)),
    privacy: normalizePrivacy(user.privacy)
  };
}

function adminSummary(data) {
  const today = todayKey();
  return {
    today,
    totalUsers: data.users.length,
    visibleUsers: data.users.filter(u => !u.hidden).length,
    hiddenUsers: data.users.filter(u => u.hidden).length,
    checkedToday: data.checkins.filter(c => c.date === today).length,
    totalCheckins: data.checkins.length,
    totalReflections: data.checkins.filter(c => c.reflection).length,
    totalUrges: data.urgeLogs.length,
    totalMessages: data.messageGraveyard.length,
    totalRelapses: data.relapseLogs.length,
    totalEncouragements: data.encouragements.length,
    verifiedUsers: data.users.filter(u => u.emailVerified).length,
    openReports: data.reports.filter(r => r.status !== 'resolved').length,
    totalReports: data.reports.length,
    emailOutbox: data.emailOutbox.length,
    adminPasswordIsDefault: ADMIN_PASSWORD === 'change-me-admin'
  };
}

function logAdminAction(data, action, details) {
  data.adminActions.push({ id: uid(), action, details, createdAt: new Date().toISOString() });
  if (data.adminActions.length > 500) data.adminActions = data.adminActions.slice(-500);
}

function findUserById(data, userId) {
  return data.users.find(u => u.id === userId) || null;
}

function removeUserData(data, userId) {
  data.checkins = data.checkins.filter(c => c.userId !== userId);
  data.urgeLogs = data.urgeLogs.filter(u => u.userId !== userId);
  data.reasons = data.reasons.filter(r => r.userId !== userId);
  data.messageGraveyard = data.messageGraveyard.filter(m => m.userId !== userId);
  data.relapseLogs = data.relapseLogs.filter(r => r.userId !== userId);
  data.encouragements = data.encouragements.filter(e => e.fromUserId !== userId && e.toUserId !== userId);
  data.sessions = data.sessions.filter(s => s.userId !== userId);
  data.emailVerificationTokens = data.emailVerificationTokens.filter(t => t.userId !== userId);
  data.passwordResetTokens = data.passwordResetTokens.filter(t => t.userId !== userId);
  data.reports = data.reports.filter(r => r.reporterId !== userId && r.targetUserId !== userId);
  data.planProgress = data.planProgress.filter(p => p.userId !== userId);
  data.resourceViews = data.resourceViews.filter(v => v.userId !== userId);
}


function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(IS_PRODUCTION ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' } : {})
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders() });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON.')); }
    });
  });
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const data = readData();

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, today: todayKey(), storage: STORAGE_DRIVER === 'postgres' && pgPool ? 'postgres' : 'json', emailProvider: EMAIL_PROVIDER, production: IS_PRODUCTION, appUrl: APP_URL });
    }

    if (req.method === 'GET' && url.pathname === '/api/community') {
      return sendJson(res, 200, communityPayload(data));
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const user = getSessionUser(data, req);
      {
        const session = getSession(data, req);
        if (session) ensureCsrf(data, session);
        writeData(data);
        return sendJson(res, 200, { authenticated: Boolean(user), user: publicAccount(user), csrfToken: session?.csrfToken || null });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      rateLimit(req, 'register', 8, 15 * 60 * 1000);
      const body = await readRequestBody(req);
      const user = createAccount(data, body);
      const verificationToken = createEmailVerificationToken(data, user);
      const token = createSession(data, user);
      writeData(data);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true, user: publicAccount(user), devVerificationToken: typeof verificationToken !== 'undefined' ? verificationToken : undefined });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      rateLimit(req, 'login', 12, 15 * 60 * 1000);
      const body = await readRequestBody(req);
      const user = findUserByEmail(data, body.email);
      if (!verifyPassword(body.password, user)) return sendJson(res, 401, { error: 'Email or password is incorrect.' });
      const token = createSession(data, user);
      writeData(data);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true, user: publicAccount(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) data.sessions = data.sessions.filter(s => s.token !== token);
      writeData(data);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }


    if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
      rateLimit(req, 'password-reset-request', 6, 60 * 60 * 1000);
      const body = await readRequestBody(req);
      const user = findUserByEmail(data, body.email);
      let devResetToken = null;
      if (user) {
        devResetToken = createPasswordResetToken(data, user);
        createEmail(data, user.email, 'Reset your No Contact Challenge password', `Reset your password here: ${APP_URL}/?reset=${devResetToken}\n\nOr paste this token into the app: ${devResetToken}`, 'password_reset');
      }
      writeData(data);
      return sendJson(res, 200, {
        ok: true,
        message: 'If an account exists for that email, a reset link would be sent.',
        devResetToken
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/confirm') {
      rateLimit(req, 'password-reset-confirm', 8, 15 * 60 * 1000);
      const body = await readRequestBody(req);
      resetPasswordWithToken(data, body.token, body.password);
      writeData(data);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true, message: 'Password reset. Please sign in again.' });
    }



    if (req.method === 'POST' && url.pathname === '/api/account/profile') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      updateAccountProfile(data, user, body);
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')), account: publicAccount(user), community: communityPayload(data) });
    }

    if (req.method === 'POST' && url.pathname === '/api/account/password') {
      requireCsrf(data, req);
      rateLimit(req, 'change-password', 8, 15 * 60 * 1000);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      if (!verifyPassword(body.currentPassword, user)) return sendJson(res, 401, { error: 'Current password is incorrect.' });
      if (String(body.newPassword || '').length < 8) return sendJson(res, 400, { error: 'New password must be at least 8 characters.' });
      const { salt, hash } = hashPassword(body.newPassword);
      user.passwordSalt = salt;
      user.passwordHash = hash;
      user.updatedAt = new Date().toISOString();
      writeData(data);
      return sendJson(res, 200, { ok: true, message: 'Password changed.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/account/export') {
      const user = requireUser(data, req);
      return sendJson(res, 200, exportUserData(data, user));
    }

    if (req.method === 'POST' && url.pathname === '/api/account/delete') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      if (!verifyPassword(body.password, user)) return sendJson(res, 401, { error: 'Password is incorrect.' });
      removeUserData(data, user.id);
      data.users = data.users.filter(u => u.id !== user.id);
      writeData(data);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true, message: 'Account and private data deleted.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = requireUser(data, req);
      return sendJson(res, 200, userPayload(data, user, url.searchParams.get('month')));
    }

    // Legacy endpoint kept only so old frontend calls do not break. It no longer creates accounts.
    if (req.method === 'POST' && url.pathname === '/api/signup') {
      requireCsrf(data, req);
      const user = requireUser(data, req);
      return sendJson(res, 200, { ok: true, user: publicAccount(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/checkin') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const today = todayKey();
      const already = data.checkins.some(c => c.userId === user.id && c.date === today);

      if (!already) {
        data.checkins.push({
          id: uid(),
          userId: user.id,
          date: today,
          createdAt: new Date().toISOString()
        });
        writeData(data);
      }

      return sendJson(res, 200, {
        ok: true,
        alreadyCheckedIn: already,
        user: userPayload(data, user, url.searchParams.get('month')),
        community: communityPayload(data)
      });
    }


    if (req.method === 'POST' && url.pathname === '/api/reflection') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const today = todayKey();
      const checkin = data.checkins.find(c => c.userId === user.id && c.date === today);
      if (!checkin) return sendJson(res, 400, { error: 'Check in first, then save your reflection.' });

      const allowedMoods = ['Calm', 'Tempted', 'Sad', 'Strong', 'Anxious', 'Hopeful'];
      const mood = allowedMoods.includes(body.mood) ? body.mood : 'Hopeful';
      const note = String(body.note || '').trim().slice(0, 500);
      checkin.reflection = { mood, note, updatedAt: new Date().toISOString() };
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')), community: communityPayload(data) });
    }

    if (req.method === 'POST' && url.pathname === '/api/urge') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      data.urgeLogs.push({
        id: uid(),
        userId: user.id,
        intensity: Math.max(1, Math.min(10, Number(body.intensity || 5))),
        note: String(body.note || '').trim().slice(0, 800),
        createdAt: new Date().toISOString()
      });
      writeData(data);
      return sendJson(res, 200, { ok: true, message: 'Urge moment saved privately.', user: userPayload(data, user, url.searchParams.get('month')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/reasons') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const payload = {
        why: String(body.why || '').trim().slice(0, 800),
        pain: String(body.pain || '').trim().slice(0, 800),
        future: String(body.future || '').trim().slice(0, 800),
        updatedAt: new Date().toISOString()
      };
      let existing = getReasons(data, user.id);
      if (existing) Object.assign(existing, payload);
      else data.reasons.push({ id: uid(), userId: user.id, ...payload });
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/privacy') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const incoming = body.privacy && typeof body.privacy === 'object' ? body.privacy : {};
      const current = normalizePrivacy(user.privacy);
      user.privacy = normalizePrivacy({ ...current, ...incoming });
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')), community: communityPayload(data) });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const message = String(body.message || '').trim().slice(0, 3000);
      if (!message) return sendJson(res, 400, { error: 'Write the message first.' });
      data.messageGraveyard.push({
        id: uid(),
        userId: user.id,
        title: String(body.title || 'Unsent message').trim().slice(0, 80),
        message,
        createdAt: new Date().toISOString()
      });
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/relapse') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const today = todayKey();
      data.relapseLogs.push({
        id: uid(),
        userId: user.id,
        date: today,
        reason: String(body.reason || 'Slip / reset').trim().slice(0, 120),
        trigger: String(body.trigger || '').trim().slice(0, 500),
        note: String(body.note || '').trim().slice(0, 800),
        createdAt: new Date().toISOString()
      });
      // A reset day should not count as a successful no-contact check-in.
      data.checkins = data.checkins.filter(c => !(c.userId === user.id && c.date === today));
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')), community: communityPayload(data) });
    }

    if (req.method === 'POST' && url.pathname === '/api/encourage') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const fromUser = requireUser(data, req);
      const toUser = data.users.find(u => u.id === body.toUserId);
      if (!toUser) return sendJson(res, 404, { error: 'Member not found.' });
      const toPrivacy = normalizePrivacy(toUser.privacy);
      if (toUser.hidden || !toPrivacy.showInCommunity || !toPrivacy.allowEncouragements) {
        return sendJson(res, 403, { error: 'This member is not accepting public encouragements.' });
      }
      if (toUser.id === fromUser.id) return sendJson(res, 400, { error: 'You cannot encourage yourself here — but you can still be kind to yourself.' });
      const today = todayKey();
      const already = data.encouragements.some(e => e.fromUserId === fromUser.id && e.toUserId === toUser.id && e.date === today);
      if (!already) {
        data.encouragements.push({ id: uid(), fromUserId: fromUser.id, toUserId: toUser.id, date: today, createdAt: new Date().toISOString() });
        writeData(data);
      }
      return sendJson(res, 200, { ok: true, alreadyEncouraged: already, community: communityPayload(data), user: userPayload(data, fromUser, url.searchParams.get('month')) });
    }


    if (req.method === 'POST' && url.pathname === '/api/auth/verify-email') {
      rateLimit(req, 'verify-email', 10, 15 * 60 * 1000);
      const body = await readRequestBody(req);
      const user = verifyEmailToken(data, body.token);
      writeData(data);
      return sendJson(res, 200, { ok: true, user: publicAccount(user), message: 'Email verified.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/resend-verification') {
      requireCsrf(data, req);
      rateLimit(req, 'resend-verification', 5, 60 * 60 * 1000);
      const user = requireUser(data, req);
      if (user.emailVerified) return sendJson(res, 200, { ok: true, message: 'Email is already verified.' });
      const devVerificationToken = createEmailVerificationToken(data, user);
      writeData(data);
      return sendJson(res, 200, { ok: true, message: 'Verification email queued.', devVerificationToken });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      user.profile = normalizeProfile({
        displayName: body.displayName || user.username,
        bio: body.bio || '',
        avatarColor: body.avatarColor || 'sage',
        anonymousMode: Boolean(body.anonymousMode)
      }, user.username);
      user.updatedAt = new Date().toISOString();
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')), community: communityPayload(data), account: publicAccount(user) });
    }

    if (req.method === 'GET' && url.pathname === '/api/resources') {
      return sendJson(res, 200, { resources: resourcesLibrary() });
    }

    if (req.method === 'POST' && url.pathname === '/api/resource/view') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const resourceId = cleanText(body.resourceId, 80);
      if (resourceId) data.resourceViews.push({ id: uid(), userId: user.id, resourceId, createdAt: new Date().toISOString() });
      writeData(data);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/plan') {
      const user = requireUser(data, req);
      return sendJson(res, 200, { plan: userPlanPayload(data, user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/plan/complete') {
      requireCsrf(data, req);
      const body = await readRequestBody(req);
      const user = requireUser(data, req);
      const stepDay = Number(body.stepDay || 0);
      const step = healingPlan().find(s => s.day === stepDay);
      if (!step) return sendJson(res, 400, { error: 'Plan step not found.' });
      if (!data.planProgress.some(p => p.userId === user.id && p.stepDay === stepDay)) {
        data.planProgress.push({ id: uid(), userId: user.id, stepDay, createdAt: new Date().toISOString() });
      }
      writeData(data);
      return sendJson(res, 200, { ok: true, user: userPayload(data, user, url.searchParams.get('month')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      requireCsrf(data, req);
      rateLimit(req, 'report', 20, 60 * 60 * 1000);
      const body = await readRequestBody(req);
      const reporter = requireUser(data, req);
      const target = findUserById(data, body.targetUserId);
      if (!target) return sendJson(res, 404, { error: 'Member not found.' });
      if (target.id === reporter.id) return sendJson(res, 400, { error: 'You cannot report yourself.' });
      data.reports.push({
        id: uid(), reporterId: reporter.id, targetUserId: target.id,
        reason: cleanText(body.reason || 'Concern', 120), details: cleanText(body.details || '', 800),
        status: 'open', createdAt: new Date().toISOString()
      });
      writeData(data);
      return sendJson(res, 200, { ok: true, message: 'Report sent to admin review.' });
    }


    if (url.pathname.startsWith('/api/admin/')) {
      requireAdmin(req);

      if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
        return sendJson(res, 200, adminSummary(data));
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/users') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const users = data.users
          .filter(u => !q || u.usernameLower.includes(q))
          .map(u => publicAdminUser(data, u))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return sendJson(res, 200, { users });
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/export') {
        return sendJson(res, 200, data);
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/actions') {
        return sendJson(res, 200, { actions: data.adminActions.slice(-100).reverse() });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/user/hide') {
        const body = await readRequestBody(req);
        const user = findUserById(data, body.userId);
        if (!user) return sendJson(res, 404, { error: 'User not found.' });
        user.hidden = Boolean(body.hidden);
        logAdminAction(data, user.hidden ? 'hide_user' : 'show_user', { userId: user.id, username: user.username });
        writeData(data);
        return sendJson(res, 200, { ok: true, user: publicAdminUser(data, user), community: communityPayload(data) });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/user/reset') {
        const body = await readRequestBody(req);
        const user = findUserById(data, body.userId);
        if (!user) return sendJson(res, 404, { error: 'User not found.' });
        removeUserData(data, user.id);
        logAdminAction(data, 'reset_user_progress', { userId: user.id, username: user.username });
        writeData(data);
        return sendJson(res, 200, { ok: true, user: publicAdminUser(data, user), community: communityPayload(data) });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/user/delete') {
        const body = await readRequestBody(req);
        const user = findUserById(data, body.userId);
        if (!user) return sendJson(res, 404, { error: 'User not found.' });
        removeUserData(data, user.id);
        data.users = data.users.filter(u => u.id !== user.id);
        logAdminAction(data, 'delete_user', { userId: user.id, username: user.username });
        writeData(data);
        return sendJson(res, 200, { ok: true, community: communityPayload(data) });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/user/rename') {
        const body = await readRequestBody(req);
        const user = findUserById(data, body.userId);
        if (!user) return sendJson(res, 404, { error: 'User not found.' });
        const clean = normalizeUsername(body.username);
        if (clean.length < 2) return sendJson(res, 400, { error: 'Username must be at least 2 characters.' });
        if (!/^[a-zA-Z0-9 _.-]+$/.test(clean)) return sendJson(res, 400, { error: 'Username can only contain letters, numbers, spaces, dots, underscores, and hyphens.' });
        const existing = getUser(data, clean);
        if (existing && existing.id !== user.id) return sendJson(res, 409, { error: 'Another user already has that username.' });
        const oldUsername = user.username;
        user.username = clean;
        user.usernameLower = clean.toLowerCase();
        logAdminAction(data, 'rename_user', { userId: user.id, oldUsername, newUsername: user.username });
        writeData(data);
        return sendJson(res, 200, { ok: true, user: publicAdminUser(data, user), community: communityPayload(data) });
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/analytics') {
        return sendJson(res, 200, analyticsPayload(data));
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/reports') {
        const reports = data.reports.slice().reverse().map(r => ({
          ...r,
          reporter: findUserById(data, r.reporterId)?.username || 'Deleted user',
          target: findUserById(data, r.targetUserId)?.username || 'Deleted user'
        }));
        return sendJson(res, 200, { reports });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/report/resolve') {
        const body = await readRequestBody(req);
        const report = data.reports.find(r => r.id === body.reportId);
        if (!report) return sendJson(res, 404, { error: 'Report not found.' });
        report.status = 'resolved';
        report.adminNote = cleanText(body.adminNote || '', 500);
        report.resolvedAt = new Date().toISOString();
        logAdminAction(data, 'resolve_report', { reportId: report.id, targetUserId: report.targetUserId });
        writeData(data);
        return sendJson(res, 200, { ok: true, report });
      }


      if (req.method === 'GET' && url.pathname === '/api/admin/system') {
        return sendJson(res, 200, {
          storage: STORAGE_DRIVER === 'postgres' && pgPool ? 'postgres' : 'json',
          emailProvider: EMAIL_PROVIDER,
          appUrl: APP_URL,
          emailFrom: EMAIL_FROM,
          queuedEmails: data.emailOutbox.filter(e => e.status === 'queued').length,
          failedEmails: data.emailOutbox.filter(e => e.status === 'failed').length,
          sentEmails: data.emailOutbox.filter(e => e.status === 'sent').length
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/emails') {
        return sendJson(res, 200, { emails: data.emailOutbox.slice(-100).reverse() });
      }

    }

    return sendJson(res, 404, { error: 'API route not found.' });
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, { error: err.message || 'Server error.' });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...securityHeaders() });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
});


function validateProductionConfig() {
  if (!IS_PRODUCTION) return;
  const missing = REQUIRED_PRODUCTION_ENV.filter(key => !process.env[key]);
  const warnings = [];
  if (missing.length) warnings.push(`Missing production env: ${missing.join(', ')}`);
  if (ADMIN_PASSWORD === 'change-me-admin') warnings.push('ADMIN_PASSWORD is still the default value.');
  if (!APP_URL.startsWith('https://')) warnings.push('APP_URL should be https:// in production.');
  if (STORAGE_DRIVER === 'json') warnings.push('STORAGE_DRIVER=json is not recommended for production. Use postgres.');
  if (EMAIL_PROVIDER === 'dev') warnings.push('EMAIL_PROVIDER=dev will not send real emails.');
  if (warnings.length) {
    console.warn('\n[PRODUCTION CONFIG WARNINGS]');
    warnings.forEach(w => console.warn(`- ${w}`));
    if (process.env.FAIL_ON_CONFIG_WARNING === 'true') {
      throw new Error('Production configuration warnings are present. Fix them or unset FAIL_ON_CONFIG_WARNING.');
    }
  }
}

validateProductionConfig();

initStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`No Contact Challenge running at http://localhost:${PORT}`);
      console.log(`Email provider: ${EMAIL_PROVIDER}`);
    });
  })
  .catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });

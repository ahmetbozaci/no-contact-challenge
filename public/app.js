const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const API = {
  community: '/api/community',
  session: '/api/auth/session',
  register: '/api/auth/register',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  passwordResetRequest: '/api/auth/password-reset/request',
  passwordResetConfirm: '/api/auth/password-reset/confirm',
  accountProfile: '/api/account/profile',
  accountPassword: '/api/account/password',
  accountExport: '/api/account/export',
  accountDelete: '/api/account/delete',
  signup: '/api/signup',
  checkin: '/api/checkin',
  reflection: '/api/reflection',
  urge: '/api/urge',
  reasons: '/api/reasons',
  message: '/api/message',
  relapse: '/api/relapse',
  encourage: '/api/encourage',
  privacy: '/api/privacy',
  me: (month = activeMonth) => `/api/me${month ? `?month=${encodeURIComponent(month)}` : ''}`
};

const LOCAL_USERNAME_KEY = 'noContactChallenge:username'; // legacy only
let activeFilter = 'all';
let community = null;
let currentUser = '';
let currentAccount = null;
let currentMe = null;
let activeMonth = new Date().toISOString().slice(0, 7);
let urgeTimerInterval = null;
let reminderInterval = null;
let csrfToken = null;

const palettes = [
  { bg: '#EAF3DE', fg: '#3B6D11' },
  { bg: '#E6F1FB', fg: '#185FA5' },
  { bg: '#FAEEDA', fg: '#BA7517' },
  { bg: '#FBEAF0', fg: '#993556' },
  { bg: '#F1EFE8', fg: '#888780' }
];

function escapeHtml(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(text || '')));
  return d.innerHTML;
}

function initials(username) {
  return String(username || '?')
    .trim()
    .split(/\s+/)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
}

function paletteFor(username) {
  const sum = String(username).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return palettes[sum % palettes.length];
}

async function requestJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, {
    headers,
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function loadCommunity() {
  try {
    community = await requestJson(API.community);
    renderCommunity();
    updateStats();
    await restoreAuthSession();
  } catch (err) {
    showToast('Could not load community. Is the backend running?');
    console.error(err);
  }
}

async function restoreAuthSession() {
  try {
    const session = await requestJson(API.session);
    csrfToken = session.csrfToken || null;
    if (!session.authenticated) {
      currentUser = '';
      currentAccount = null;
      setAuthUI(null);
      renderProgress(null);
      renderAccountSettings(null);
      return;
    }
    currentAccount = session.user;
    currentUser = session.user.username;
    setAuthUI(session.user);
    const input = $('#usernameInput');
    if (input) input.value = currentUser;
    const me = await requestJson(API.me());
    currentMe = me;
    updateCheckinUI(me);
    renderProgress(me);
    renderAccountSettings(session.user);
  } catch (err) {
    currentUser = '';
    currentAccount = null;
    setAuthUI(null);
  }
}

function requireSignedIn() {
  if (currentAccount && currentUser) return true;
  showAuthModal('login');
  showToast('Please sign in first.');
  return false;
}

function setAuthUI(user) {
  const input = $('#usernameInput');
  const sign = $('#signInBtn');
  if (input) {
    input.value = user?.username || '';
    input.placeholder = user ? 'Signed in display name' : 'Sign in to track privately';
    input.readOnly = Boolean(user);
  }
  if (sign) sign.textContent = user ? 'Account' : 'Sign in';
}


function renderCommunity() {
  if (!community) return;
  const tbody = $('#communityTable');
  if (!tbody) return;

  const members = community.members || [];
  const filtered = members.filter(member => activeFilter === 'all' || member.status === activeFilter);

  if (filtered.length === 0) {
    const message = activeFilter === 'all'
      ? 'No members yet. Enter a username and complete the first check-in to start the community dashboard.'
      : 'No members match this filter yet.';
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${message}</td></tr>`;
    $('#memberCount').textContent = '0 members';
    return;
  }

  tbody.innerHTML = filtered.map(member => {
    const c = paletteFor(member.username);
    const isYou = currentUser && member.username.toLowerCase() === currentUser.toLowerCase();
    const statusHtml = member.status === 'in'
      ? '<span class="badge in"><span class="badge-dot"></span>Checked in</span>'
      : '<span class="badge pending"><span class="badge-dot"></span>Pending</span>';

    return `
      <tr data-status="${member.status}" class="${isYou ? 'highlight' : ''}">
        <td><div class="user-cell">
          <div class="avatar" style="background:${c.bg};color:${c.fg}">${initials(member.username)}${isYou ? '<div class="avatar-ring"></div>' : ''}</div>
          <span class="username">${escapeHtml(member.username)}${isYou ? '<span class="username-you">you</span>' : ''}</span>
        </div></td>
        <td>${statusHtml}${member.mood ? `<div class="mini-mood">${escapeHtml(member.mood)}</div>` : ''}</td>
        <td>${member.streakHidden ? '<span class="privacy-muted">Hidden</span>' : `<div class="streak-cell">${member.currentStreak} ${member.currentStreak === 1 ? 'day' : 'days'}${renderStreakBar(member.currentStreak)}</div>${renderMemberBadges(member.milestones)}`}</td>
        <td><span class="last-seen">${escapeHtml(member.lastCheckinLabel || 'Never')}</span></td>
        <td>${member.allowEncouragements ? `<button type="button" class="encourage-btn" onclick="sendEncouragement('${member.id}')" ${isYou ? 'disabled' : ''}>🌿 ${member.encouragements || 0}</button>` : '<span class="privacy-muted">Off</span>'}</td>
      </tr>
    `;
  }).join('');

  $('#memberCount').textContent = `${filtered.length} member${filtered.length !== 1 ? 's' : ''}`;
}

function renderStreakBar(days) {
  const filled = Math.min(Number(days) || 0, 7);
  let html = '<div class="streak-bar">';
  for (let i = 0; i < 7; i++) html += `<div class="streak-pip${i < filled ? ' filled' : ''}"></div>`;
  html += '</div>';
  return html;
}

function renderMemberBadges(milestones = []) {
  const visible = milestones.slice(-2);
  if (!visible.length) return '';
  return `<div class="mini-badges">${visible.map(m => `<span title="${escapeHtml(m.title)}">${m.emoji} ${m.days}d</span>`).join('')}</div>`;
}

function updateStats() {
  if (!community) return;
  const stats = community.stats || {};
  const todayChecked = $('#todayCheckedStat');
  const longest = $('#longestStreakStat');
  const support = $('#supportScoreStat');

  if (todayChecked) todayChecked.textContent = Number(stats.checkedToday || 0).toLocaleString('en-US');
  if (longest) longest.textContent = `${stats.longestStreak || 0} days`;
  if (support) support.textContent = `${stats.supportScore || 4.8} / 5`;

  const heroTag = $('.hero-tag');
  if (heroTag) {
    const dot = heroTag.querySelector('.hero-tag-dot')?.outerHTML || '<div class="hero-tag-dot"></div>';
    heroTag.innerHTML = `${dot}${Number(stats.checkedToday || 0).toLocaleString('en-US')} members checked in today`;
  }
}

function updateCheckinUI(me) {
  const btn = $('#checkinBtn');
  const mark = $('#checkMark');
  const label = $('#btnLabel');
  const sublabel = $('#btnSublabel');
  const panel = $('#confirmPanel');
  const streak = $('#streakCount');

  if (streak) {
    const days = Number(me.currentStreak || 0);
    streak.textContent = `${days} day${days !== 1 ? 's' : ''} streak`;
  }

  if (me.checkedToday) {
    btn?.classList.add('done');
    if (mark) {
      mark.style.display = 'block';
      mark.style.opacity = '1';
    }
    if (label) label.textContent = 'Check-in complete!';
    if (sublabel) sublabel.textContent = 'You showed up for yourself today 🌱';
    panel?.classList.add('visible');
    if (me.reflectionToday) {
      hideReflectionPanel();
    } else {
      showReflectionPanel();
    }
  } else {
    btn?.classList.remove('done');
    if (mark) {
      mark.style.display = 'none';
      mark.style.opacity = '0';
    }
    if (label) label.textContent = 'I stayed no-contact today';
    if (sublabel) sublabel.textContent = 'Tap to record your daily check-in';
    panel?.classList.remove('visible');
    hideReflectionPanel();
  }
}

function showReflectionPanel() {
  const panel = $('#reflectionPanel');
  if (panel) panel.hidden = false;
}

function hideReflectionPanel() {
  const panel = $('#reflectionPanel');
  if (panel) panel.hidden = true;
}


function validateUsername(username) {
  const error = $('#usernameError');
  const row = $('.input-row');
  const clean = String(username || '').trim().replace(/\s+/g, ' ');

  if (!clean) {
    if (error) error.textContent = 'Please enter a username first.';
    row?.classList.add('input-error');
    $('#usernameInput')?.focus();
    return null;
  }
  if (clean.length < 2) {
    if (error) error.textContent = 'Username must be at least 2 characters.';
    row?.classList.add('input-error');
    $('#usernameInput')?.focus();
    return null;
  }
  if (!/^[a-zA-Z0-9 _.-]+$/.test(clean)) {
    if (error) error.textContent = 'Use only letters, numbers, spaces, dots, underscores, or hyphens.';
    row?.classList.add('input-error');
    $('#usernameInput')?.focus();
    return null;
  }

  if (error) error.textContent = '';
  row?.classList.remove('input-error');
  return clean;
}

async function handleCheckin() {
  if (!requireSignedIn()) return;

  try {
    const result = await requestJson(API.checkin, {
      method: 'POST',
      body: JSON.stringify({})
    });

    currentUser = result.user.username;
    currentAccount = result.user.account || currentAccount;
    community = result.community;
    currentMe = result.user;

    updateCheckinUI(result.user);
    renderCommunity();
    updateStats();
    renderProgress(result.user);

    if (result.alreadyCheckedIn) {
      showToast('You already checked in today.');
      showInfoModal('Already checked in', 'Your check-in for today is already saved. Come back tomorrow to continue your streak.');
    } else {
      showToast(`${currentUser} checked in!`);
      showInfoModal('You did it!', `Welcome, ${currentUser}! Your check-in has been saved. Add a quick reflection below to track how you feel today.`);
    }
  } catch (err) {
    showToast(err.message || 'Could not check in.');
  }
}


function moodOptions() {
  return Array.from($$('.mood-option')).find(button => button.classList.contains('active'))?.dataset.mood || '';
}

async function saveReflection() {
  if (!requireSignedIn()) return;
  const mood = moodOptions();
  if (!mood) {
    showToast('Choose how you feel today first.');
    return;
  }
  try {
    const result = await requestJson(API.reflection, {
      method: 'POST',
      body: JSON.stringify({ mood, note: $('#reflectionNote')?.value || '' })
    });
    currentMe = result.user;
    community = result.community;
    hideReflectionPanel();
    renderCommunity();
    updateStats();
    renderProgress(result.user);
    showToast('Reflection saved privately.');
  } catch (err) {
    showToast(err.message || 'Could not save reflection.');
  }
}

function renderProgress(me) {
  renderCalendar(me?.calendar);
  renderMilestones(me?.milestones || []);
  renderPrivateDashboard(me);
  renderReasons(me?.dashboard?.reasons || null);
  renderDailyQuote(me?.quote || null);
  renderPrivacyControls(me?.privacy || {});
  const hint = $('#progressHint');
  if (hint) {
    hint.textContent = me
      ? `${me.username}, your private calendar and milestones are shown below.`
      : 'Enter a username and check in to unlock your personal calendar and milestones.';
  }
}

function renderCalendar(calendar) {
  const grid = $('#calendarGrid');
  const title = $('#calendarTitle');
  if (!grid) return;
  if (!calendar) {
    if (title) title.textContent = 'Progress calendar';
    grid.innerHTML = '<div class="calendar-empty">No calendar yet.</div>';
    return;
  }
  if (title) title.textContent = new Date(`${calendar.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = labels.map(d => `<div class="calendar-weekday">${d}</div>`).join('');
  for (let i = 0; i < calendar.firstWeekday; i++) html += '<div class="calendar-day blank"></div>';
  html += calendar.days.map(day => {
    const classes = ['calendar-day', day.checked ? 'checked' : '', day.isToday ? 'today' : ''].filter(Boolean).join(' ');
    const mood = day.mood ? `<span class="calendar-mood">${escapeHtml(day.mood[0])}</span>` : '';
    return `<div class="${classes}" title="${day.date}${day.mood ? ` — ${escapeHtml(day.mood)}` : ''}"><span>${day.day}</span>${mood}</div>`;
  }).join('');
  grid.innerHTML = html;
}

function renderMilestones(milestones) {
  const wrap = $('#milestoneList');
  if (!wrap) return;
  wrap.innerHTML = milestones.map(m => `
    <div class="milestone ${m.unlocked ? 'unlocked' : 'locked'}">
      <div class="milestone-emoji">${m.emoji}</div>
      <div><strong>${m.days} days</strong><span>${escapeHtml(m.title)}</span></div>
    </div>
  `).join('');
}

function renderPrivateDashboard(me) {
  const dash = me?.dashboard;
  const ids = {
    privateTotalCheckins: dash?.totalCheckins || 0,
    privateCurrentStreak: dash?.currentStreak || 0,
    privateLongestStreak: dash?.longestStreak || 0,
    privateReflectionCount: dash?.reflectionCount || 0,
    privateUrgeCount: dash?.urgeCount || 0,
    privateMessageCount: dash?.unsentMessageCount || 0,
    privateRelapseCount: dash?.relapseCount || 0,
    privateEncouragementCount: dash?.encouragementsReceived || 0
  };
  Object.entries(ids).forEach(([id, value]) => { const el = $('#' + id); if (el) el.textContent = value; });

  const moods = $('#recentMoodsList');
  if (moods) {
    const items = dash?.recentMoods || [];
    moods.innerHTML = items.length ? items.map(item => `<li><strong>${escapeHtml(item.date)}</strong> — ${escapeHtml(item.mood)}${item.note ? `<span>${escapeHtml(item.note)}</span>` : ''}</li>`).join('') : '<li>No reflections yet.</li>';
  }
  const messages = $('#graveyardList');
  if (messages) {
    const items = dash?.recentMessages || [];
    messages.innerHTML = items.length ? items.map(item => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span></li>`).join('') : '<li>No unsent messages saved yet.</li>';
  }
  const relapses = $('#relapseList');
  if (relapses) {
    const items = dash?.recentRelapses || [];
    relapses.innerHTML = items.length ? items.map(item => `<li><strong>${escapeHtml(item.date)} — ${escapeHtml(item.reason)}</strong><span>${escapeHtml(item.trigger || item.note || 'Restarted gently.')}</span></li>`).join('') : '<li>No reset moments saved.</li>';
  }
}

function renderReasons(reasons) {
  const why = $('#reasonWhy');
  const pain = $('#reasonPain');
  const future = $('#reasonFuture');
  if (why && reasons) why.value = reasons.why || '';
  if (pain && reasons) pain.value = reasons.pain || '';
  if (future && reasons) future.value = reasons.future || '';
  const preview = $('#reasonsPreview');
  if (preview) {
    if (!reasons || (!reasons.why && !reasons.pain && !reasons.future)) {
      preview.textContent = 'Save your reasons, and the urge button will remind you why you started.';
    } else {
      preview.innerHTML = [reasons.why, reasons.pain, reasons.future].filter(Boolean).map(escapeHtml).join('<br>');
    }
  }
}

function renderDailyQuote(quote) {
  const el = $('#dailyQuoteText');
  if (el) el.textContent = quote?.text || 'One day at a time is still a direction.';
}



function renderAccountSettings(account) {
  const name = $('#accountDisplayName');
  const email = $('#accountEmail');
  const status = $('#accountStatusText');
  if (name) name.value = account?.username || '';
  if (email) email.value = account?.email || '';
  if (status) status.textContent = account ? `Signed in as ${account.username}` : 'Sign in to manage account settings.';
}

async function saveAccountProfile() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.accountProfile, {
      method: 'POST',
      body: JSON.stringify({ username: $('#accountDisplayName')?.value || '', email: $('#accountEmail')?.value || '' })
    });
    currentAccount = result.account;
    currentUser = result.account.username;
    currentMe = result.user;
    community = result.community;
    setAuthUI(currentAccount);
    renderAccountSettings(currentAccount);
    renderCommunity();
    renderProgress(currentMe);
    showToast('Account profile updated.');
  } catch (err) { showToast(err.message || 'Could not update account.'); }
}

async function changeAccountPassword() {
  if (!requireSignedIn()) return;
  const currentPassword = $('#currentPassword')?.value || '';
  const newPassword = $('#newPassword')?.value || '';
  try {
    await requestJson(API.accountPassword, { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    if ($('#currentPassword')) $('#currentPassword').value = '';
    if ($('#newPassword')) $('#newPassword').value = '';
    showToast('Password changed.');
  } catch (err) { showToast(err.message || 'Could not change password.'); }
}

async function exportMyData() {
  if (!requireSignedIn()) return;
  try {
    const data = await requestJson(API.accountExport);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `no-contact-data-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Data export downloaded.');
  } catch (err) { showToast(err.message || 'Could not export data.'); }
}

async function deleteMyAccount() {
  if (!requireSignedIn()) return;
  const ok = confirm('This permanently deletes your account and private data from this prototype. Continue?');
  if (!ok) return;
  const password = prompt('Enter your password to confirm deletion:');
  if (!password) return;
  try {
    await requestJson(API.accountDelete, { method: 'POST', body: JSON.stringify({ password }) });
    csrfToken = null;
    csrfToken = null;
  currentAccount = null; currentUser = ''; currentMe = null;
    setAuthUI(null);
    renderAccountSettings(null);
    renderProgress(null);
    await loadCommunity();
    showToast('Account deleted.');
  } catch (err) { showToast(err.message || 'Could not delete account.'); }
}

async function forgotPasswordFlow() {
  const email = prompt('Enter your account email:');
  if (!email) return;
  try {
    const result = await requestJson(API.passwordResetRequest, { method: 'POST', body: JSON.stringify({ email }) });
    const token = result.devResetToken || prompt('If you received a reset token by email, paste it here:');
    if (!token) {
      showToast(result.message || 'Reset requested.');
      return;
    }
    const password = prompt(`Prototype reset token:\n${token}\n\nEnter a new password with at least 8 characters:`);
    if (!password) return;
    await requestJson(API.passwordResetConfirm, { method: 'POST', body: JSON.stringify({ token, password }) });
    showToast('Password reset. Please sign in again.');
    showAuthModal('login');
  } catch (err) { showToast(err.message || 'Could not reset password.'); }
}

function renderPrivacyControls(privacy = {}) {
  const defaults = {
    showInCommunity: true,
    showStreak: true,
    showLastCheckin: true,
    showMilestones: true,
    showMood: false,
    allowEncouragements: true
  };
  const value = { ...defaults, ...(privacy || {}) };
  Object.entries(value).forEach(([key, checked]) => {
    const input = document.querySelector(`[data-privacy="${key}"]`);
    if (input) input.checked = Boolean(checked);
  });
}

function collectPrivacyControls() {
  const privacy = {};
  $$('[data-privacy]').forEach(input => { privacy[input.dataset.privacy] = input.checked; });
  return privacy;
}

async function savePrivacy() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.privacy, {
      method: 'POST',
      body: JSON.stringify({ privacy: collectPrivacyControls() })
    });
    currentMe = result.user;
    community = result.community;
    renderCommunity();
    updateStats();
    renderProgress(currentMe);
    showToast('Privacy settings saved.');
  } catch (err) {
    showToast(err.message || 'Could not save privacy settings.');
  }
}

async function saveReasons() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.reasons, {
      method: 'POST',
      body: JSON.stringify({
        why: $('#reasonWhy')?.value || '',
        pain: $('#reasonPain')?.value || '',
        future: $('#reasonFuture')?.value || ''
      })
    });
    currentMe = result.user;
    renderProgress(result.user);
    showToast('Reasons saved privately.');
  } catch (err) { showToast(err.message || 'Could not save reasons.'); }
}

async function saveGraveyardMessage() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.message, {
      method: 'POST',
      body: JSON.stringify({ title: $('#graveyardTitle')?.value || 'Unsent message', message: $('#graveyardMessage')?.value || '' })
    });
    $('#graveyardTitle').value = '';
    $('#graveyardMessage').value = '';
    currentMe = result.user;
    renderProgress(result.user);
    showToast('Message saved instead of sent.');
  } catch (err) { showToast(err.message || 'Could not save message.'); }
}

async function saveRelapse() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.relapse, {
      method: 'POST',
      body: JSON.stringify({
        reason: $('#relapseReason')?.value || 'Slip / reset',
        trigger: $('#relapseTrigger')?.value || '',
        note: $('#relapseNote')?.value || ''
      })
    });
    $('#relapseTrigger').value = '';
    $('#relapseNote').value = '';
    currentMe = result.user;
    community = result.community;
    updateCheckinUI(result.user);
    renderCommunity();
    updateStats();
    renderProgress(result.user);
    showInfoModal('Restart gently', 'Your streak was reset for today, but your healing is not erased. Notice the trigger, make a safer plan, and begin again.', '🫶');
  } catch (err) { showToast(err.message || 'Could not save reset.'); }
}

async function sendEncouragement(toUserId) {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.encourage, { method: 'POST', body: JSON.stringify({ toUserId }) });
    community = result.community;
    currentMe = result.user;
    renderCommunity();
    renderProgress(result.user);
    showToast(result.alreadyEncouraged ? 'You already encouraged this member today.' : 'Encouragement sent.');
  } catch (err) { showToast(err.message || 'Could not send encouragement.'); }
}

function startUrgeTimer(seconds = 20 * 60) {
  clearInterval(urgeTimerInterval);
  let remaining = seconds;
  const timer = $('#urgeTimer');
  const button = $('#startTimerBtn');
  if (button) button.disabled = true;
  function tick() {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    if (timer) timer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (remaining <= 0) {
      clearInterval(urgeTimerInterval);
      if (button) button.disabled = false;
      showInfoModal('Timer complete', 'Check in with yourself again. The urge may be smaller now. You still do not have to contact them.', '⏳');
      return;
    }
    remaining -= 1;
  }
  tick();
  urgeTimerInterval = setInterval(tick, 1000);
}

async function enableReminder() {
  const time = $('#reminderTime')?.value || '20:00';
  localStorage.setItem('noContactChallenge:reminderTime', time);
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  setupReminderChecker();
  showToast('Daily reminder enabled on this browser.');
}

function setupReminderChecker() {
  clearInterval(reminderInterval);
  const time = localStorage.getItem('noContactChallenge:reminderTime');
  if (!time) return;
  const input = $('#reminderTime');
  if (input) input.value = time;
  reminderInterval = setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const key = `noContactChallenge:lastReminder:${now.toISOString().slice(0,10)}`;
    if (hhmm === time && localStorage.getItem(key) !== '1') {
      localStorage.setItem(key, '1');
      if ('Notification' in window && Notification.permission === 'granted') new Notification('No Contact Challenge', { body: 'Gentle reminder: check in with yourself today 🌿' });
      else showToast('Gentle reminder: check in with yourself today 🌿');
    }
  }, 30000);
}

function disableReminder() {
  localStorage.removeItem('noContactChallenge:reminderTime');
  clearInterval(reminderInterval);
  showToast('Reminder disabled.');
}

async function changeCalendarMonth(offset) {
  const [y, m] = activeMonth.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1 + offset, 1));
  activeMonth = next.toISOString().slice(0, 7);
  if (!currentUser) {
    renderProgress(null);
    return;
  }
  try {
    currentMe = await requestJson(API.me(activeMonth));
    renderProgress(currentMe);
  } catch (err) {
    showToast('Could not load that month.');
  }
}

function openUrgeModal() {
  const username = $('#usernameInput')?.value?.trim();
  const name = username ? `, ${escapeHtml(username)}` : '';
  const overlay = $('#urgeOverlay');
  if (!overlay) return;
  const reasons = currentMe?.dashboard?.reasons;
  const reasonText = reasons ? [reasons.why, reasons.pain, reasons.future].filter(Boolean).map(escapeHtml).join('<br>') : '';
  $('#urgeMessage').innerHTML = `Pause${name}. You do not need to decide right now. Breathe, write it here instead of sending it, then wait 20 minutes.`;
  const reminder = $('#urgeReasons');
  if (reminder) reminder.innerHTML = reasonText || 'No reasons saved yet. Add your reasons below so this emergency screen can remind you.';
  overlay.classList.add('open');
  $('#urgeNote')?.focus();
}

function closeUrgeModal(e) {
  if (!e || e.target === $('#urgeOverlay')) $('#urgeOverlay')?.classList.remove('open');
}

async function saveUrgeMoment() {
  if (!requireSignedIn()) return;
  try {
    const result = await requestJson(API.urge, {
      method: 'POST',
      body: JSON.stringify({ intensity: $('#urgeIntensity')?.value || 5, note: $('#urgeNote')?.value || '' })
    });
    currentMe = result.user || currentMe;
    renderProgress(currentMe);
    $('#urgeOverlay')?.classList.remove('open');
    showToast('Urge moment saved privately. Wait 20 minutes before acting.');
  } catch (err) {
    showToast(err.message || 'Could not save urge moment.');
  }
}

function filterTable(status, btn) {
  activeFilter = status;
  $$('.filter-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  renderCommunity();
}

function showToast(msg) {
  const toast = $('#toast');
  const text = $('#toastText');
  if (!toast || !text) return;
  text.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function showInfoModal(title, message, emoji = '🌿') {
  const overlay = $('#modalOverlay');
  if (!overlay) return;
  $('.modal-emoji').textContent = emoji;
  $('.modal-title').textContent = title;
  $('#modalMessage').textContent = message;
  overlay.classList.add('open');
}

function closeModal(e) {
  if (!e || e.target === $('#modalOverlay')) $('#modalOverlay')?.classList.remove('open');
}

function focusUsername() {
  document.getElementById('dashboard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!currentAccount) {
    setTimeout(() => showAuthModal('register'), 250);
  } else {
    setTimeout(() => $('#checkinBtn')?.focus(), 350);
  }
}

function ensureAuthModal() {
  if ($('#authOverlay')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-overlay" id="authOverlay" onclick="closeAuthModal(event)">
      <div class="modal auth-modal" style="text-align:left;max-width:460px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
          <div>
            <span class="modal-emoji" style="font-size:32px;margin-bottom:8px">🔐</span>
            <div class="modal-title" id="authTitle">Sign in</div>
          </div>
          <button type="button" class="btn-small" onclick="closeAuthModal()">Close</button>
        </div>
        <p class="modal-sub" id="authSub">Use a private account so your dashboard belongs only to you.</p>
        <div id="authAccountBox" hidden></div>
        <form id="authForm">
          <label class="field-label">Email</label>
          <div class="input-row" style="margin-bottom:12px"><input type="email" id="authEmail" autocomplete="email" placeholder="you@example.com"></div>
          <div id="displayNameWrap">
            <label class="field-label">Display name</label>
            <div class="input-row" style="margin-bottom:12px"><input type="text" id="authUsername" autocomplete="nickname" placeholder="Public display name"></div>
          </div>
          <label class="field-label">Password</label>
          <div class="input-row" style="margin-bottom:12px"><input type="password" id="authPassword" autocomplete="current-password" placeholder="At least 8 characters"></div>
          <p id="authError" class="input-error-text" style="margin-bottom:12px"></p>
          <div class="reflection-actions">
            <button type="submit" class="btn-small primary" id="authSubmitBtn">Sign in</button>
            <button type="button" class="btn-small" id="authToggleBtn">Create account</button>
            <button type="button" class="btn-small" id="forgotPasswordBtn">Forgot password?</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
  $('#authForm')?.addEventListener('submit', submitAuthForm);
  $('#authToggleBtn')?.addEventListener('click', () => showAuthModal(authMode === 'login' ? 'register' : 'login'));
  $('#forgotPasswordBtn')?.addEventListener('click', forgotPasswordFlow);
}

let authMode = 'login';
function showAuthModal(mode = 'login') {
  ensureAuthModal();
  authMode = mode;
  const isAccount = mode === 'account' && currentAccount;
  const isRegister = mode === 'register';
  $('#authTitle').textContent = isAccount ? 'Your account' : (isRegister ? 'Create private account' : 'Sign in');
  $('#authSub').textContent = isAccount ? 'You are signed in. Your private dashboard is tied to this account.' : 'Use email + password so other people cannot access your private notes by typing your display name.';
  $('#displayNameWrap').hidden = !isRegister;
  $('#authSubmitBtn').textContent = isRegister ? 'Create account' : 'Sign in';
  $('#authToggleBtn').textContent = isRegister ? 'I already have an account' : 'Create account';
  const forgotBtn = $('#forgotPasswordBtn');
  if (forgotBtn) forgotBtn.hidden = isRegister || isAccount;
  $('#authForm').hidden = isAccount;
  const accountBox = $('#authAccountBox');
  if (accountBox) {
    accountBox.hidden = !isAccount;
    accountBox.innerHTML = isAccount ? `<p class="modal-sub"><strong>${escapeHtml(currentAccount.username)}</strong><br>${escapeHtml(currentAccount.email || '')}</p><button type="button" class="btn-small primary" id="logoutBtn">Log out</button>` : '';
    $('#logoutBtn')?.addEventListener('click', logoutAccount);
  }
  $('#authError').textContent = '';
  $('#authOverlay')?.classList.add('open');
  setTimeout(() => $('#authEmail')?.focus(), 50);
}

function closeAuthModal(e) {
  if (!e || e.target === $('#authOverlay')) $('#authOverlay')?.classList.remove('open');
}

async function submitAuthForm(e) {
  e.preventDefault();
  const email = $('#authEmail')?.value || '';
  const password = $('#authPassword')?.value || '';
  const username = $('#authUsername')?.value || '';
  const error = $('#authError');
  try {
    const result = await requestJson(authMode === 'register' ? API.register : API.login, {
      method: 'POST',
      body: JSON.stringify(authMode === 'register' ? { email, password, username } : { email, password })
    });
    currentAccount = result.user;
    currentUser = result.user.username;
    setAuthUI(result.user);
    $('#authOverlay')?.classList.remove('open');
    await loadCommunity();
    showToast(authMode === 'register' ? 'Account created.' : 'Signed in.');
  } catch (err) {
    if (error) error.textContent = err.message || 'Could not sign in.';
  }
}

async function logoutAccount() {
  try { await requestJson(API.logout, { method: 'POST', body: JSON.stringify({}) }); } catch {}
  currentAccount = null; currentUser = ''; currentMe = null;
  setAuthUI(null);
  $('#authOverlay')?.classList.remove('open');
  renderProgress(null);
  await loadCommunity();
  showToast('Logged out.');
}

function attachEvents() {
  $('#startBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    focusUsername();
  });

  $('.nav-cta .btn-primary')?.addEventListener('click', (e) => {
    const href = e.currentTarget.getAttribute('href') || '';
    if (href === '#dashboard') {
      e.preventDefault();
      focusUsername();
    }
  });

  $('#signInBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthModal(currentAccount ? 'account' : 'login');
  });

  $('.view-all-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    activeFilter = 'all';
    $$('.filter-btn').forEach(b => b.classList.remove('active'));
    $('.filter-btn')?.classList.add('active');
    renderCommunity();
    showToast('Showing all community members.');
  });

  $$('.footer-links a').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href') || '';
      if (href && href !== '#') return; // real legal/support pages should open normally
      e.preventDefault();
      showInfoModal(link.textContent, `${link.textContent} page placeholder. You can connect this to a real page later.`, '📄');
    });
  });

  $('#usernameInput')?.addEventListener('input', () => {
    $('#usernameError').textContent = '';
    $('.input-row')?.classList.remove('input-error');
  });

  $$('.mood-option').forEach(button => {
    button.addEventListener('click', () => {
      $$('.mood-option').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
    });
  });

  $('#saveReflectionBtn')?.addEventListener('click', saveReflection);
  $('#skipReflectionBtn')?.addEventListener('click', hideReflectionPanel);
  $('#urgeBtn')?.addEventListener('click', openUrgeModal);
  $('#saveUrgeBtn')?.addEventListener('click', saveUrgeMoment);
  $('#closeUrgeBtn')?.addEventListener('click', () => $('#urgeOverlay')?.classList.remove('open'));
  $('#prevMonthBtn')?.addEventListener('click', () => changeCalendarMonth(-1));
  $('#nextMonthBtn')?.addEventListener('click', () => changeCalendarMonth(1));
  $('#saveReasonsBtn')?.addEventListener('click', saveReasons);
  $('#savePrivacyBtn')?.addEventListener('click', savePrivacy);
  $('#saveGraveyardBtn')?.addEventListener('click', saveGraveyardMessage);
  $('#saveRelapseBtn')?.addEventListener('click', saveRelapse);
  $('#startTimerBtn')?.addEventListener('click', () => startUrgeTimer());
  $('#enableReminderBtn')?.addEventListener('click', enableReminder);
  $('#disableReminderBtn')?.addEventListener('click', disableReminder);
  $('#saveAccountBtn')?.addEventListener('click', saveAccountProfile);
  $('#changePasswordBtn')?.addEventListener('click', changeAccountPassword);
  $('#exportDataBtn')?.addEventListener('click', exportMyData);
  $('#deleteAccountBtn')?.addEventListener('click', deleteMyAccount);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modalOverlay')?.classList.remove('open');
      $('#urgeOverlay')?.classList.remove('open');
      $('#authOverlay')?.classList.remove('open');
    }
  });
}

function setupRevealAnimations() {
  const reveals = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    reveals.forEach(el => el.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        entry.target.style.transitionDelay = (i * 0.05) + 's';
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  reveals.forEach(el => observer.observe(el));
}

window.handleCheckin = handleCheckin;
window.filterTable = filterTable;
window.closeModal = closeModal;
window.closeUrgeModal = closeUrgeModal;
window.closeAuthModal = closeAuthModal;
window.sendEncouragement = sendEncouragement;

attachEvents();
setupRevealAnimations();
setupReminderChecker();
loadCommunity();

/* Launch-readiness feature bundle: verification, profile/avatar, reports, healing plan, resources */
Object.assign(API, {
  verifyEmail: '/api/auth/verify-email',
  resendVerification: '/api/auth/resend-verification',
  profile: '/api/profile',
  report: '/api/report',
  resources: '/api/resources',
  resourceView: '/api/resource/view',
  plan: '/api/plan',
  planComplete: '/api/plan/complete'
});

function injectLaunchSections() {
  if (document.getElementById('launchBundleSection')) return;
  const features = document.getElementById('features');
  const section = document.createElement('section');
  section.id = 'launchBundleSection';
  section.className = 'features-section launch-section';
  section.innerHTML = `
    <style>
      .launch-section{background:#FAFAF7}.launch-wrap{max-width:1100px;margin:0 auto}.launch-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:22px}.launch-card{background:#fff;border:0.5px solid var(--border);border-radius:18px;padding:22px;box-shadow:0 2px 16px rgba(0,0,0,.04)}.launch-card h3{font-family:'Lora',serif;font-size:20px;margin-bottom:8px}.launch-card p{color:var(--gray-500);font-size:13.5px}.launch-card input,.launch-card textarea,.launch-card select{width:100%;border:0.5px solid var(--border);border-radius:10px;padding:11px;margin-top:8px;font-family:'DM Sans',sans-serif;background:var(--beige-50)}.launch-card textarea{min-height:72px;resize:vertical}.launch-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.small-launch-btn{font-family:'DM Sans',sans-serif;border:0;border-radius:9px;padding:9px 12px;background:var(--green-600);color:#fff;cursor:pointer;font-weight:500}.small-launch-btn.secondary{background:var(--beige-200);color:var(--gray-900)}.small-launch-btn.danger{background:var(--pink)}.verify-box{padding:12px;border-radius:12px;background:var(--amber-light);color:#7a4b09;margin-top:12px;font-size:13px}.plan-list,.resource-list{display:grid;gap:10px;margin-top:12px}.plan-item,.resource-item{border:0.5px solid var(--border-light);background:var(--beige-50);border-radius:12px;padding:13px}.plan-item.locked{opacity:.55}.plan-item.done{background:var(--green-50);border-color:var(--green-100)}.mini-tag{display:inline-flex;border-radius:999px;padding:2px 8px;background:var(--green-50);color:var(--green-600);font-size:11px;margin-right:4px}.report-btn{margin-left:6px;border:0;background:transparent;color:var(--gray-400);font-size:12px;cursor:pointer}.report-btn:hover{color:var(--pink)}@media(max-width:850px){.launch-grid{grid-template-columns:1fr}}
    </style>
    <div class="launch-wrap">
      <h2 class="features-title">Launch-ready tools</h2>
      <p class="features-sub">Account trust, profile privacy, reporting, guided healing, and resource library.</p>
      <div class="launch-grid">
        <div class="launch-card">
          <h3>Profile & avatar</h3>
          <p>Choose how you appear publicly. Anonymous mode hides your chosen display name and bio.</p>
          <input id="profileDisplayName" placeholder="Display name" />
          <textarea id="profileBio" placeholder="Short optional bio"></textarea>
          <select id="profileAvatarColor"><option value="sage">Sage</option><option value="blue">Blue</option><option value="amber">Amber</option><option value="rose">Rose</option><option value="stone">Stone</option><option value="violet">Violet</option><option value="teal">Teal</option></select>
          <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input id="profileAnonymous" type="checkbox" style="width:auto;margin:0"/> Anonymous mode</label>
          <div class="launch-actions"><button class="small-launch-btn" id="saveProfileBtn">Save profile</button></div>
        </div>
        <div class="launch-card">
          <h3>Email verification</h3>
          <p>For local testing, verification emails are saved in the server dev outbox and printed in the terminal.</p>
          <div id="verifyStatus" class="verify-box">Sign in to check verification status.</div>
          <input id="verifyTokenInput" placeholder="Paste local verification token" />
          <div class="launch-actions"><button class="small-launch-btn" id="verifyEmailBtn">Verify email</button><button class="small-launch-btn secondary" id="resendVerifyBtn">Resend token</button></div>
        </div>
        <div class="launch-card">
          <h3>Guided healing plan</h3>
          <p>Steps unlock as the streak grows. Completed steps stay saved privately.</p>
          <div class="plan-list" id="healingPlanList"></div>
        </div>
        <div class="launch-card">
          <h3>Resources library</h3>
          <p>Short, practical reading cards for difficult moments.</p>
          <div class="resource-list" id="resourcesList"></div>
        </div>
      </div>
    </div>`;
  features ? features.after(section) : document.body.insertBefore(section, document.querySelector('footer'));
  document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfileLaunch);
  document.getElementById('verifyEmailBtn')?.addEventListener('click', verifyEmailLaunch);
  document.getElementById('resendVerifyBtn')?.addEventListener('click', resendVerificationLaunch);
  renderLaunchSections();
}

function renderLaunchSections() {
  const me = currentMe;
  const profile = me?.profile || currentAccount?.profile || {};
  if (document.getElementById('profileDisplayName')) {
    document.getElementById('profileDisplayName').value = profile.displayName || currentUser || '';
    document.getElementById('profileBio').value = profile.bio || '';
    document.getElementById('profileAvatarColor').value = profile.avatarColor || 'sage';
    document.getElementById('profileAnonymous').checked = Boolean(profile.anonymousMode);
  }
  const status = document.getElementById('verifyStatus');
  if (status) status.textContent = !currentAccount ? 'Sign in to check verification status.' : (currentAccount.emailVerified || me?.emailVerified ? '✅ Email verified.' : '⚠️ Email not verified yet. Use Resend token, then paste the local token here.');
  const plan = document.getElementById('healingPlanList');
  if (plan) {
    const steps = me?.healingPlan || [];
    plan.innerHTML = steps.length ? steps.map(s => `<div class="plan-item ${s.completed?'done':''} ${!s.unlocked?'locked':''}"><strong>Day ${s.day}: ${escapeHtml(s.title)}</strong><p>${escapeHtml(s.action)}</p><div class="launch-actions">${s.completed ? '<span class="mini-tag">Completed</span>' : s.unlocked ? `<button class="small-launch-btn secondary" onclick="completePlanStep(${s.day})">Mark complete</button>` : '<span class="mini-tag">Locked</span>'}</div></div>`).join('') : '<p>Sign in to see your healing plan.</p>';
  }
  const res = document.getElementById('resourcesList');
  if (res) {
    const resources = me?.resources || [];
    res.innerHTML = resources.length ? resources.map(r => `<div class="resource-item"><span class="mini-tag">${escapeHtml(r.category)}</span><span class="mini-tag">${r.minutes} min</span><h4>${escapeHtml(r.title)}</h4><p>${escapeHtml(r.body)}</p><div class="launch-actions"><button class="small-launch-btn secondary" onclick="markResourceViewed('${r.id}')">Mark read</button></div></div>`).join('') : '<p>Sign in to view resources.</p>';
  }
  addReportButtonsToCommunity();
}

async function refreshMeLaunch() {
  if (!currentAccount) return;
  const me = await requestJson(API.me());
  currentMe = me;
  renderLaunchSections();
  renderProgress(me);
}

async function saveProfileLaunch() {
  if (!requireSignedIn()) return;
  try {
    const data = await requestJson(API.profile, { method:'POST', body: JSON.stringify({
      displayName: document.getElementById('profileDisplayName').value,
      bio: document.getElementById('profileBio').value,
      avatarColor: document.getElementById('profileAvatarColor').value,
      anonymousMode: document.getElementById('profileAnonymous').checked
    })});
    currentMe = data.user; currentAccount = data.account || currentAccount; community = data.community || community;
    renderCommunity(); renderLaunchSections(); showToast('Profile saved.');
  } catch(err){ showToast(err.message); }
}
async function verifyEmailLaunch() {
  try {
    const token = document.getElementById('verifyTokenInput').value.trim();
    const data = await requestJson(API.verifyEmail, { method:'POST', body: JSON.stringify({ token }) });
    currentAccount = data.user || currentAccount; await refreshMeLaunch(); showToast('Email verified.');
  } catch(err){ showToast(err.message); }
}
async function resendVerificationLaunch() {
  if (!requireSignedIn()) return;
  try {
    const data = await requestJson(API.resendVerification, { method:'POST', body: JSON.stringify({}) });
    if (data.devVerificationToken) document.getElementById('verifyTokenInput').value = data.devVerificationToken;
    showToast(data.devVerificationToken ? 'Local token generated and pasted.' : data.message);
  } catch(err){ showToast(err.message); }
}
window.completePlanStep = async function(stepDay) {
  if (!requireSignedIn()) return;
  try { const data = await requestJson(API.planComplete, { method:'POST', body: JSON.stringify({ stepDay }) }); currentMe = data.user; renderLaunchSections(); showToast('Plan step completed.'); } catch(err){ showToast(err.message); }
};
window.markResourceViewed = async function(resourceId) {
  if (!requireSignedIn()) return;
  try { await requestJson(API.resourceView, { method:'POST', body: JSON.stringify({ resourceId }) }); showToast('Resource marked as read.'); } catch(err){ showToast(err.message); }
};
function addReportButtonsToCommunity() {
  const rows = document.querySelectorAll('#communityTable tr[data-status]');
  rows.forEach((row, index) => {
    if (row.querySelector('.report-btn')) return;
    const member = (community?.members || []).filter(m => activeFilter === 'all' || m.status === activeFilter)[index];
    if (!member || (currentAccount && member.realUsername && member.realUsername.toLowerCase() === currentUser.toLowerCase())) return;
    const cell = row.querySelector('td:last-child');
    if (cell) cell.insertAdjacentHTML('beforeend', `<button class="report-btn" onclick="reportMemberLaunch('${member.id}')">Report</button>`);
  });
}
window.reportMemberLaunch = async function(targetUserId) {
  if (!requireSignedIn()) return;
  const reason = prompt('Reason for report? Example: inappropriate username, abuse, spam');
  if (!reason) return;
  const details = prompt('Optional details for admin review:', '') || '';
  try { await requestJson(API.report, { method:'POST', body: JSON.stringify({ targetUserId, reason, details }) }); showToast('Report sent to admin.'); } catch(err){ showToast(err.message); }
};

const __oldRenderCommunity = renderCommunity;
renderCommunity = function(){ __oldRenderCommunity(); setTimeout(addReportButtonsToCommunity, 0); };
const __oldRenderProgress = renderProgress;
renderProgress = function(me){ __oldRenderProgress(me); currentMe = me || currentMe; setTimeout(renderLaunchSections, 0); };
const __oldSetAuthUI = setAuthUI;
setAuthUI = function(user){ __oldSetAuthUI(user); currentAccount = user; setTimeout(renderLaunchSections, 0); };

setTimeout(injectLaunchSections, 200);

async function handleEmailActionLinks() {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verify');
  const resetToken = params.get('reset');
  if (verifyToken) {
    try {
      const data = await requestJson('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
      currentAccount = data.user || currentAccount;
      await loadCommunity();
      showToast('Email verified.');
      history.replaceState({}, document.title, window.location.pathname);
    } catch (err) {
      showToast(err.message || 'Verification link failed.');
    }
  }
  if (resetToken) {
    const password = prompt('Enter a new password with at least 8 characters:');
    if (password) {
      try {
        await requestJson('/api/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token: resetToken, password }) });
        showToast('Password reset. Please sign in again.');
        history.replaceState({}, document.title, window.location.pathname);
        showAuthModal('login');
      } catch (err) {
        showToast(err.message || 'Reset link failed.');
      }
    }
  }
}
handleEmailActionLinks();

/* Legal/PWA bundle: install prompt + service worker */
let deferredInstallPrompt = null;
function setupPwaInstall() {
  const installBtn = document.getElementById('installAppBtn');
  if (!installBtn) return;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) {
    installBtn.hidden = true;
    return;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      showModal('Install this app', 'On iPhone/iPad: tap Share, then Add to Home Screen. On Chrome/Android/Desktop: use the browser install option if available.');
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    showToast('App installed.');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // PWA support is optional; the app still works without it.
    });
  });
}

setupPwaInstall();
registerServiceWorker();

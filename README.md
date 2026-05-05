# No Contact Challenge — Private Accounts Backend Prototype

## Recommended production setup

For this project, the easiest serious deployment is:

```text
Render = Node.js web service
Supabase = PostgreSQL database
Resend = verification/password reset emails
```

Use `.env.render-supabase-example` for the exact environment variables and `docs/RENDER_SUPABASE_RESEND.md` for the deployment steps.


This is a beginner-friendly Node.js + JSON-file backend prototype for the No Contact Challenge website.

## Run locally

```bash
cd no-contact-backend
npm start
```

Open:

```text
http://localhost:3000
```

## What is included

- Real email + password account registration
- Password hashing with PBKDF2 + per-user salt
- HTTP-only session cookie login
- Logout
- Account settings: update display name and email
- Change password while signed in
- Prototype password reset flow for local testing
- Download/export my private data
- Delete my account and private data
- Basic CSRF token checks for signed-in POST actions
- Basic rate limiting for login/register/password reset/password change
- Security headers for static files and API responses
- Private user IDs instead of trusting public usernames
- Daily no-contact check-in
- Server-side streak calculation
- Shared community dashboard
- Daily reflection after check-in
- Private progress calendar
- Milestone badges
- Emergency urge support modal
- 20-minute urge pause timer
- Private urge logging
- Private dashboard / journey stats
- “Reasons I started” card
- Message graveyard for unsent messages
- Relapse / reset support
- Daily quote / affirmation
- Browser reminder prototype
- Community encouragement button
- User privacy controls for community visibility, streak, last check-in, milestones, mood, and encouragements
- Admin panel

## Account behavior

Users now create an account with:

- Email
- Password
- Public display name

Private actions such as check-ins, reflections, reasons, unsent messages, urge logs, relapse/reset logs, privacy settings, and encouragement sending require an active session. Other people can no longer access someone’s private dashboard just by typing their display name.


## Account settings and data rights

Signed-in users can update their display name/email, change password, download their private data as JSON, and delete their account. The password reset flow is included as a prototype: for local testing the reset token is returned by the API and displayed in the browser flow. In production, send that token by email and never show it directly to the user.

## Data storage

The app stores data in `data.json`, created automatically when the server starts.

This is good for testing and demos, but not production-grade. Passwords are hashed, but the JSON file is still a simple local file and should be protected.

## Important production notes

Before launching publicly, move from this JSON-file prototype to a real production stack:

- Supabase Auth / Firebase Auth / custom auth with PostgreSQL
- Database-backed sessions
- HTTPS-only cookies
- Production-grade rate limiting backed by Redis or your database
- Real password reset emails instead of the local-testing token shown in the browser
- Email verification
- Strong CSRF/session strategy reviewed for your deployment
- Encrypted handling for sensitive notes
- Role-based admin accounts instead of a single admin password

## Privacy note

Reflections, reasons, urge notes, relapse notes, and unsent messages are never shown in the public community dashboard. Users can also control whether they appear in the community, whether their streak/last check-in/milestones/mood are shown, and whether they accept encouragements.

## Admin panel

Open the admin page after the server starts:

```text
http://localhost:3000/admin.html
```

For local testing, the default admin password is:

```text
change-me-admin
```

Before hosting publicly, change the password by starting the server like this:

```bash
ADMIN_PASSWORD="your-strong-password" npm start
```

Admin panel features:

- View total users, visible/hidden users, check-ins, reflections, urges, unsent messages, relapses, and encouragements
- Search users by username
- Hide/show users on the public community dashboard
- Rename users
- Reset a user's progress and private data
- Delete a user and all related data
- Export the full JSON data file
- View recent admin moderation actions

Important: this is still prototype-level admin protection. For a public launch, replace the simple admin password with real authentication and role-based admin accounts.

## Added launch bundle

This version adds the remaining suggested launch features:

- Email verification flow
  - Registration creates a verification token.
  - In this local prototype, emails are written to the dev email outbox and printed in the terminal.
  - Users can resend and verify using the local token.
- Local email system prototype
  - Password reset and verification messages are stored in `emailOutbox`.
  - Admin can inspect `/api/admin/emails` through the admin panel.
  - For production, replace `createEmail()` in `server.js` with SMTP/Resend/Postmark/SendGrid.
- Reporting and safer moderation
  - Community rows include a Report action.
  - Admin panel includes report queue and resolve action.
- Profile and avatar system
  - Display name, short bio, avatar color, and anonymous mode.
  - Anonymous mode shows the user as “Anonymous Member” in public community.
- Better admin analytics
  - Last 30 days: check-ins, reflections, urges, relapses, encouragements.
  - Admin summary includes verified users, reports, and email outbox count.
- Guided healing plan
  - Day 1, 3, 7, 14, 30, 60, and 90 steps.
  - Steps unlock by streak and can be marked complete.
- Resources library
  - Short support cards for urges, profile checking, lonely nights, relapse, and romanticizing the past.
  - Resource views are tracked privately.

## Database note

The app still runs with a JSON file so it remains easy to test locally. The data model is now structured around durable IDs and separate collections, so it is ready to migrate to PostgreSQL/Supabase/Firebase later. A production migration should move these collections into real tables: `users`, `sessions`, `checkins`, `reasons`, `urge_logs`, `message_graveyard`, `relapse_logs`, `encouragements`, `reports`, `email_outbox`, `plan_progress`, and `resource_views`.

## Legal/privacy pages + PWA bundle

This version also adds starter public/legal pages and mobile-app style support.

### Added legal/support pages

- `/privacy.html` — starter privacy policy
- `/terms.html` — starter terms of use
- `/safety.html` — safety and crisis disclaimer
- `/support.html` — support/contact placeholder

These pages are templates for planning only. Before a public launch, have a qualified legal professional review them and replace placeholder contact details.

### Added PWA/mobile features

- `manifest.webmanifest`
- `service-worker.js`
- `offline.html`
- SVG app icons in `/public/icons/`
- Install button in the top navigation when supported by the browser
- iOS/Android home-screen metadata
- Offline fallback page for navigation requests

Notes:

- PWA install behavior depends on browser support. iPhone users usually install via Safari Share → Add to Home Screen.
- Service workers require HTTPS in production. They can also work on `localhost` during development.
- API requests are not cached by the service worker, so private account data is not intentionally stored for offline use.

## Real database + real email provider bundle

This version adds a production-oriented storage/email layer while keeping the easy local JSON mode.

### Storage modes

By default the app still uses local `data.json`:

```bash
npm start
```

To use PostgreSQL, install dependencies and start with `DATABASE_URL`:

```bash
npm install
DATABASE_URL="postgres://user:password@host:5432/no_contact" \
STORAGE_DRIVER=postgres \
npm start
```

The app creates an `app_state` table automatically and stores the application state as JSONB. This is a practical stepping stone away from `data.json`: it gives you real database persistence, managed backups, and easier hosting while keeping the prototype code simple.

For hosted PostgreSQL providers that require SSL, use:

```bash
PGSSLMODE=require DATABASE_URL="..." STORAGE_DRIVER=postgres npm start
```

Recommended providers:

- Supabase PostgreSQL
- Neon
- Railway PostgreSQL
- Render PostgreSQL
- Fly Postgres

### Migrating existing local data into PostgreSQL

1. Keep your existing `data.json` in the project folder.
2. Set `DATABASE_URL` and `STORAGE_DRIVER=postgres`.
3. Start the server once.
4. If PostgreSQL has no existing `app_state` row, the app imports your local `data.json` automatically.

### Real email sending with Resend

Local/dev mode still writes verification and reset emails to the dev outbox and terminal.

To send real emails with Resend:

```bash
npm install
EMAIL_PROVIDER=resend \
RESEND_API_KEY="re_xxxxxxxxx" \
EMAIL_FROM="No Contact Challenge <hello@yourdomain.com>" \
APP_URL="https://yourdomain.com" \
npm start
```

Email verification and password-reset messages will contain real links like:

```text
https://yourdomain.com/?verify=TOKEN
https://yourdomain.com/?reset=TOKEN
```

The frontend now recognizes those links automatically.

### New system health details

`/api/health` now returns the active storage and email provider:

```json
{
  "ok": true,
  "storage": "postgres",
  "emailProvider": "resend"
}
```

Admin-only `/api/admin/system` also reports storage, email provider, queued emails, sent emails, and failed emails.

### Important production notes

This is a strong transition layer, but the cleanest long-term production architecture would eventually move from the single `app_state` JSONB row into normalized tables such as `users`, `sessions`, `checkins`, `reports`, and `email_outbox`.

Before launch, also configure:

- HTTPS
- Strong `ADMIN_PASSWORD`
- Production domain in `APP_URL`
- Verified sender/domain in Resend
- Hosted PostgreSQL backups
- Monitoring/logging

---

## Deployment-ready additions

This version includes a deployment/security/backup layer:

- `.env.example` for production configuration
- `render.yaml` for Render deployment
- `railway.json` for Railway deployment
- `docs/DEPLOYMENT.md`
- `docs/SECURITY.md`
- `docs/BACKUP_RESTORE.md`
- `docs/QA_CHECKLIST.md`
- JSON backup/restore scripts
- PostgreSQL backup/restore scripts
- Production config warnings on startup
- Production HSTS header
- Secure cookies when `NODE_ENV=production`
- Configurable request body limit with `MAX_BODY_BYTES`
- `/api/health` now reports storage/email/production mode

### Local quick start

```bash
npm install
npm start
```

### Production-style start

```bash
cp .env.example .env
# Fill real values in your hosting dashboard or local shell.
NODE_ENV=production \
APP_URL="https://your-domain.com" \
ADMIN_PASSWORD="replace-with-long-random-password" \
STORAGE_DRIVER=postgres \
DATABASE_URL="postgres://user:password@host:5432/no_contact" \
PGSSLMODE=require \
EMAIL_PROVIDER=resend \
RESEND_API_KEY="re_xxxxxxxxx" \
EMAIL_FROM="No Contact Challenge <hello@your-domain.com>" \
npm start
```

### Backup commands

JSON mode:

```bash
npm run backup:json
npm run restore:json -- ./backups/data-example.json
```

PostgreSQL mode:

```bash
DATABASE_URL="postgres://..." npm run backup:pg
DATABASE_URL="postgres://..." npm run restore:pg -- ./backups/no-contact-example.sql
```

Read these before launch:

- `docs/DEPLOYMENT.md`
- `docs/SECURITY.md`
- `docs/BACKUP_RESTORE.md`
- `docs/QA_CHECKLIST.md`
# QA checklist

Run this before deploying and after every major change.

## Auth

- Register a new account.
- Verify email from dev outbox or real email.
- Log out and log back in.
- Try wrong password and confirm error appears.
- Use forgot password flow.
- Change password from account settings.

## Core app

- Complete today's check-in.
- Refresh page and confirm streak/check-in remain.
- Save daily reflection.
- Use urge button and save an urge note.
- Save a message to the message graveyard.
- Record a relapse/reset and confirm streak behavior.
- Complete an unlocked healing plan step.
- Open resources and confirm they load.

## Privacy/community

- Hide user from community and confirm they disappear publicly.
- Hide streak/last check-in/milestones/mood and confirm public table respects it.
- Disable encouragements and confirm others cannot encourage that user.
- Report a user and confirm admin can see the report.

## Admin

- Open `/admin.html`.
- Confirm wrong admin password fails.
- View users/stats/reports/emails/system status.
- Hide/show a user.
- Rename a test user.
- Export data.
- Resolve a report.

## PWA/mobile

- Open on mobile width.
- Install to home screen where supported.
- Visit offline fallback after service worker installs.
- Check footer links to Privacy, Terms, Safety, Support.

## Production

- `/api/health` returns `ok: true`.
- Storage shows `postgres` if production database is enabled.
- Email provider shows `resend` if real email is enabled.
- Cookies have Secure flag over HTTPS.
- Password reset and verification links use the public `APP_URL`.

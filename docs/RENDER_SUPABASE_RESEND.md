# Render + Supabase + Resend setup

This is the recommended simple production setup for this project:

- **Render** hosts the Node.js app.
- **Supabase** provides PostgreSQL.
- **Resend** sends verification and password-reset emails.

## 1. Create the Supabase database

1. Create a Supabase project.
2. Go to **Project Settings → Database**.
3. Copy a Postgres connection string.
4. Prefer the **Transaction pooler** connection string for hosted apps when available.
5. Replace the password placeholder with your real database password.

Use these environment values in Render:

```bash
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true
PGSSLMODE=require
```

If the pooler URL gives trouble, use the direct Supabase database URL instead. Keep `PGSSLMODE=require`.

## 2. Create the Resend email sender

1. Create a Resend account.
2. Add and verify your sending domain.
3. Create an API key.
4. Use an email address on the verified domain.

Render environment values:

```bash
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=No Contact Challenge <hello@yourdomain.com>
```

For quick testing before verifying a domain, Resend may allow limited test sending depending on your account. For public launch, use a verified domain.

## 3. Deploy the app to Render

1. Push this project folder to GitHub.
2. In Render, create a **Web Service** from the GitHub repo.
3. Use these settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
4. Add environment variables from `.env.render-supabase-example`.
5. Deploy.

After the first deploy, set:

```bash
APP_URL=https://your-render-service-name.onrender.com
```

If you later add a custom domain, update `APP_URL` to that custom domain.

## 4. Verify production status

Open:

```text
https://your-render-service-name.onrender.com/api/health
```

Expected result:

- `ok: true`
- `storage: postgres`
- `email: resend`
- `production: true`

## 5. Test the full user flow

1. Register with an email.
2. Check the email verification message.
3. Click verification link.
4. Log in.
5. Check in for today.
6. Add a reflection.
7. Open privacy settings.
8. Log out and log back in.
9. Test forgot password.
10. Open admin panel and check analytics.

## 6. Important production notes

- Do not use `data.json` as the real database for public users.
- Do not use the dev email outbox for real users.
- Use a long random `ADMIN_PASSWORD`.
- Keep `NODE_ENV=production` and `TRUST_PROXY=true` on Render.
- Keep `PGSSLMODE=require` for Supabase.
- Backup the database regularly from Supabase.

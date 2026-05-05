# Deployment guide

## Recommended production stack

- Hosting: Render or Railway
- Storage: PostgreSQL
- Email: Resend
- HTTPS: provided by your hosting platform

## Environment variables

Copy `.env.example` and set real values in your host dashboard. Do not commit real secrets.

Minimum production variables:

```bash
NODE_ENV=production
APP_URL=https://your-domain.com
TRUST_PROXY=true
ADMIN_PASSWORD=long-random-password
STORAGE_DRIVER=postgres
DATABASE_URL=postgres://...
PGSSLMODE=require
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
EMAIL_FROM="No Contact Challenge <hello@your-domain.com>"
```


## Recommended Render + Supabase + Resend path

For the simplest real deployment, use:

```text
Render Web Service + Supabase PostgreSQL + Resend Email
```

Use `.env.render-supabase-example` as the Render environment checklist and see `docs/RENDER_SUPABASE_RESEND.md` for step-by-step setup.

## Render

1. Push this folder to GitHub.
2. Create a PostgreSQL database in Render.
3. Create a Web Service from the repo.
4. Use `render.yaml` or manually set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check: `/api/health`
5. Add the environment variables above.
6. Set `APP_URL` to the final HTTPS URL.

## Railway

1. Push to GitHub.
2. Create a Railway project from the repo.
3. Add a PostgreSQL service.
4. Add the environment variables above.
5. Railway will use `railway.json` for health check and start command.

## Health check

Visit:

```text
/api/health
```

It should show `ok: true`, the storage mode, email provider, and production mode.

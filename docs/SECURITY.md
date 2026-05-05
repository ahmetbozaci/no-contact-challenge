# Production security checklist

Before real users:

- Use `NODE_ENV=production`.
- Use HTTPS and set `APP_URL` to the HTTPS domain.
- Set a strong `ADMIN_PASSWORD`; never use `change-me-admin`.
- Use `STORAGE_DRIVER=postgres` instead of JSON storage.
- Use `EMAIL_PROVIDER=resend` or another real provider.
- Keep `TRUST_PROXY=true` only behind a trusted host/proxy.
- Keep secrets in environment variables, not in files.
- Rotate admin password if shared during testing.
- Review legal/privacy/safety pages with real business/contact details.
- Back up the database daily.
- Monitor logs for repeated failed logins or admin attempts.

Current protections included:

- Password hashing with PBKDF2 + per-user salt.
- HTTP-only session cookie.
- Secure cookie flag in production.
- Basic CSRF token for signed-in POST actions.
- Basic IP rate limiting.
- Request body size limit via `MAX_BODY_BYTES`.
- Security headers including HSTS in production.

Known limitations:

- Admin auth is still password-header based, not role-based user login.
- Rate limiting is in memory and resets on server restart.
- PostgreSQL currently stores app state in one JSONB row. It works, but normalized tables are better long-term.

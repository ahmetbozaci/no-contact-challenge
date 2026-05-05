# Backup and restore

## JSON mode

Create backup:

```bash
npm run backup:json
```

Restore backup:

```bash
npm run restore:json -- ./backups/data-YYYY-MM-DD.json
```

Restart the server after restore.

## PostgreSQL mode

Requires `pg_dump` and `psql` installed on your machine/server.

Create backup:

```bash
DATABASE_URL="postgres://..." npm run backup:pg
```

Restore backup:

```bash
DATABASE_URL="postgres://..." npm run restore:pg -- ./backups/no-contact-YYYY.sql
```

For hosted databases, also enable provider-level scheduled backups when available.

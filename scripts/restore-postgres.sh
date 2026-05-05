#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/restore-postgres.sh ./backups/no-contact.sql" >&2
  exit 1
fi
psql "$DATABASE_URL" < "$1"
echo "PostgreSQL restore finished from: $1"

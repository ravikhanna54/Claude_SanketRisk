#!/usr/bin/env bash
# Restore test: decrypt the newest backup and load it into a throw-away Postgres, then report what came back.
# Usage: backup/restore-test.sh <encrypted .gpg file>      Env: BACKUP_PASSPHRASE, RESTORE_DB_URL
set -u
FILE="$1"
DB="${RESTORE_DB_URL:-postgresql://postgres:test@localhost:5432/postgres}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
W=$(mktemp -d); cd "$W"

echo "== 1. Decrypt and unpack"
gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -d -o raw.tar.gz "$FILE" || { echo "FAIL: cannot decrypt (wrong passphrase or damaged file)"; exit 1; }
tar -xzf raw.tar.gz || { echo "FAIL: cannot unpack"; exit 1; }
SQL=$(find . -name database-public.sql | head -1)
[ -n "$SQL" ] || { echo "FAIL: database-public.sql not in backup"; exit 1; }
ls -l "$SQL"; cat "$(dirname "$SQL")/manifest.json" 2>/dev/null | head -20

echo "== 2. Prepare empty test database (stand-ins for Supabase roles, auth and extensions)"
EXT_SCHEMA=public; grep -q 'extensions\.\(geometry\|geography\)' "$SQL" && EXT_SCHEMA=extensions
psql "$DB" -q -v ON_ERROR_STOP=0 <<SQLEOF
create schema if not exists extensions;
do \$\$ begin
  create role anon nologin; exception when duplicate_object then null; end \$\$;
do \$\$ begin
  create role authenticated nologin; exception when duplicate_object then null; end \$\$;
do \$\$ begin
  create role service_role nologin; exception when duplicate_object then null; end \$\$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
create or replace function auth.role() returns text language sql stable as 'select null::text';
create or replace function auth.email() returns text language sql stable as 'select null::text';
create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
create extension if not exists "uuid-ossp" schema extensions;
create extension if not exists pgcrypto schema extensions;
SQLEOF
if grep -qi 'geometry\|geography' "$SQL"; then
  psql "$DB" -q -c "create extension if not exists postgis schema $EXT_SCHEMA;" || echo "NOTE: PostGIS not available here; spatial columns will show as errors"
fi
psql "$DB" -q -c "alter database postgres set search_path = public, extensions;" >/dev/null 2>&1
DB2="$DB"

echo "== 3. Restore"
START=$(date +%s)
PGOPTIONS="-c search_path=public,extensions" psql "$DB2" -q -v ON_ERROR_STOP=0 -f "$SQL" >restore.out 2>restore.err
echo "restore took $(( $(date +%s) - START ))s"
grep -v 'schema "public" already exists' restore.err > restore.err2; mv restore.err2 restore.err
ERRS=$(grep -c "ERROR:" restore.err)
echo "errors during restore: $ERRS"
echo "--- most common error kinds (first 15):"
grep "ERROR:" restore.err | sed -E 's/"[^"]*"/"…"/g' | sort | uniq -c | sort -rn | head -15

echo "== 4. What came back"
psql "$DB" -At -F ' | ' -c "
select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as rows
from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;" | tee tables.txt
NT=$(wc -l < tables.txt); NR=$(awk -F' \\| ' '{s+=$2} END{print s+0}' tables.txt)
FN=$(psql "$DB" -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")
PO=$(psql "$DB" -At -c "select count(*) from pg_policies where schemaname='public';")
echo "tables: $NT   total rows: $NR   functions: $FN   security policies: $PO   errors: $ERRS"
{
  echo "### Restore test"
  echo "Tables restored: **$NT** | Total rows: **$NR** | Functions: **$FN** | Policies: **$PO** | Errors: **$ERRS**"
  echo; echo '```'; cat tables.txt; echo '```'
} >> "$SUMMARY"
if [ "$NT" -lt 1 ] || [ "$NR" -lt 1 ]; then echo "FAIL: nothing restored"; head -30 restore.err; exit 1; fi
echo "PASS: backup decrypts, unpacks and loads."

#!/usr/bin/env bash
# Checks the migration on throwaway local Postgres databases, once with
# Supabase's default Data API settings and once with the recommended ones
# (new tables not exposed, automatic RLS on; stubs.sql):
#   supabase/tests/run.sh   (needs psql and a local server you can create databases on)
set -euo pipefail
cd "$(dirname "$0")"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
DBS=()
trap 'for db in "${DBS[@]}"; do "${PSQL[@]}" -d postgres -c "drop database if exists $db" >/dev/null; done' EXIT
for recommended in off on; do
  DB=selection_ai_check_$$_$recommended
  DBS+=("$DB")
  echo "Recommended Data API settings: $recommended"
  "${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null
  "${PSQL[@]}" -d "$DB" -v recommended=$recommended -f stubs.sql
  "${PSQL[@]}" -d "$DB" -f ../migrations/20261006000000_accounts.sql
  "${PSQL[@]}" -d "$DB" -f ../migrations/20261006000000_accounts.sql   # runs twice cleanly
  "${PSQL[@]}" -d "$DB" -f checks.sql
done

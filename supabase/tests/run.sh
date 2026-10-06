#!/usr/bin/env bash
# Checks the migration on a throwaway local Postgres database:
#   supabase/tests/run.sh   (needs psql and a local server you can create databases on)
set -euo pipefail
cd "$(dirname "$0")"
DB=selection_ai_check_$$
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
"${PSQL[@]}" -d "$DB" -f stubs.sql
"${PSQL[@]}" -d "$DB" -f ../migrations/20261006000000_accounts.sql
"${PSQL[@]}" -d "$DB" -f ../migrations/20261006000000_accounts.sql   # runs twice cleanly
"${PSQL[@]}" -d "$DB" -f checks.sql

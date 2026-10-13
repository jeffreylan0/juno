-- Just enough of Supabase for the migration to run on plain Postgres 16:
-- the API roles, auth.users and auth.uid(), storage.buckets/objects and
-- storage.foldername(). Used only by run.sh.
create extension if not exists pgcrypto;
do $$ begin
  create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- The project's Data API settings; run.sh checks both (-v recommended=on|off).
--   off: Supabase's defaults. "Automatically expose new tables" grants
--        everything new in public to the API roles.
--   on:  what Supabase recommends. Nothing is granted by default, and
--        "Enable automatic RLS" turns row level security on for every new
--        table in public (an event trigger).
-- The migration states every privilege and policy itself, so both pass.
grant usage on schema public to anon, authenticated, service_role;
\if :recommended
create schema if not exists stub;
create or replace function stub.rls_auto_enable() returns event_trigger language plpgsql as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() where schema_name = 'public' and object_type = 'table' loop
    execute format('alter table %s enable row level security', cmd.object_identity);
  end loop;
end $$;
drop event trigger if exists rls_auto_enable;
create event trigger rls_auto_enable on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function stub.rls_auto_enable();
\else
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
\endif

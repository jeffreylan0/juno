-- Selection AI: accounts, cloud chats and hosted-answer quotas.
--
-- Run once, as is, in the Supabase dashboard's SQL editor (or with
-- `supabase db push`). Safe to run again: every statement replaces what an
-- earlier run made.
--
-- What it sets up:
--   entitlements  what each account may use. Nobody gets cloud storage or
--                 hosted answers until you say so (set_entitlement below).
--   chats         cloud copies of saved chats, for accounts with cloud storage.
--                 Written only through push_chats (last write wins) and
--                 never really deleted by the extension: a deleted chat
--                 becomes a tombstone so other computers delete it too.
--   screenshots   a private storage bucket, one folder per account.
--   usage         hosted answers used per month, counted by the Worker.
--
-- Signed-in students reach these tables with their own session token and the
-- publishable key; row level security keeps each account to its own rows.
-- The secret key (the Worker's) bypasses it.

-- ── Entitlements ─────────────────────────────────────────────────────────

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Cloud storage for chats and their screenshots.
  cloud boolean not null default false,
  -- Hosted answers: a plan, and optionally a monthly question count that
  -- overrides the plan's (monthly_quota below). No plan, no hosted answers.
  plan text check (plan in ('student', 'unlimited')),
  monthly_questions integer check (monthly_questions >= 0),
  -- For billing later; never shown to the student.
  stripe_customer text unique,
  plan_renews_at timestamptz,
  note text,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;
revoke all on public.entitlements from anon, authenticated;
grant select (cloud, plan, monthly_questions, plan_renews_at) on public.entitlements to authenticated;
drop policy if exists "own entitlements" on public.entitlements;
create policy "own entitlements" on public.entitlements
  for select to authenticated using (user_id = (select auth.uid()));

-- Questions a month on hosted answers.
create or replace function public.monthly_quota(p_plan text, p_override integer)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(p_override, case p_plan when 'student' then 600 when 'unlimited' then 100000 else 0 end)
$$;

-- Whether the signed-in account has cloud storage. Security definer so the
-- policies below can ask without depending on the entitlements policy.
create or replace function public.has_cloud()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select e.cloud from public.entitlements e where e.user_id = (select auth.uid())), false)
$$;
revoke execute on function public.has_cloud() from public, anon;
grant execute on function public.has_cloud() to authenticated;

-- For you, in the SQL editor: give an account cloud storage and/or a plan.
--   select public.set_entitlement('friend@example.com');                       -- cloud storage
--   select public.set_entitlement('friend@example.com', true, 'student');      -- and 600 hosted answers a month
--   select public.set_entitlement('friend@example.com', true, 'student', 50);  -- and 50 a month instead
--   select public.set_entitlement('friend@example.com', false);                -- take it all away
-- The account must exist: they sign in once first.
create or replace function public.set_entitlement(
  p_email text,
  p_cloud boolean default true,
  p_plan text default null,
  p_monthly_questions integer default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No account for %. They need to sign in once first.', p_email;
  end if;
  insert into public.entitlements (user_id, cloud, plan, monthly_questions, updated_at)
  values (uid, p_cloud, p_plan, p_monthly_questions, now())
  on conflict (user_id) do update
    set cloud = excluded.cloud, plan = excluded.plan, monthly_questions = excluded.monthly_questions, updated_at = now();
end $$;
revoke execute on function public.set_entitlement(text, boolean, text, integer) from public, anon, authenticated;

-- ── Chats ────────────────────────────────────────────────────────────────

create table if not exists public.chats (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The extension's chat id (a UUID).
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- When the chat last changed, by the clock of the computer that changed it
  -- (ms since 1970). The newer one wins.
  updated_ms bigint not null,
  deleted boolean not null default false,
  -- The chat as the extension stores it; screenshots are references into the
  -- bucket, not pixels. Null once deleted.
  data jsonb,
  -- When this row last changed here: what other computers pull by.
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id),
  constraint chat_or_tombstone check (deleted = (data is null)),
  constraint chat_size check (data is null or pg_column_size(data) <= 2000000)
);
create index if not exists chats_by_sync on public.chats (user_id, synced_at);

alter table public.chats enable row level security;
revoke all on public.chats from anon, authenticated;
grant select, insert, update on public.chats to authenticated;
drop policy if exists "read own chats" on public.chats;
create policy "read own chats" on public.chats
  for select to authenticated using (user_id = (select auth.uid()));
-- Saving needs cloud storage; deleting (a tombstone) never does, so chats can
-- always be removed.
drop policy if exists "add own chats" on public.chats;
create policy "add own chats" on public.chats
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (deleted or (select public.has_cloud())));
drop policy if exists "change own chats" on public.chats;
create policy "change own chats" on public.chats
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (deleted or (select public.has_cloud())));

-- Saves up to 50 chats (or tombstones) at once. A row older than what is
-- already here changes nothing. Returns how many rows changed.
create or replace function public.push_chats(p_rows jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'push_chats takes an array of at most 50 chats' using errcode = '22023';
  end if;
  insert into public.chats as c (user_id, id, updated_ms, deleted, data, synced_at)
  select (select auth.uid()), r.id, r.updated_ms, coalesce(r.deleted, false),
         case when coalesce(r.deleted, false) then null else r.data end, clock_timestamp()
  from jsonb_to_recordset(p_rows) as r (id text, updated_ms bigint, deleted boolean, data jsonb)
  on conflict (user_id, id) do update
    set updated_ms = excluded.updated_ms, deleted = excluded.deleted, data = excluded.data, synced_at = clock_timestamp()
    where excluded.updated_ms > c.updated_ms;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.push_chats(jsonb) from public, anon;
grant execute on function public.push_chats(jsonb) to authenticated;

-- "Delete all chats": every chat of this account becomes a tombstone.
create or replace function public.delete_all_chats()
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  update public.chats
     set deleted = true, data = null,
         updated_ms = greatest(updated_ms + 1, (extract(epoch from clock_timestamp()) * 1000)::bigint),
         synced_at = clock_timestamp()
   where user_id = (select auth.uid()) and not deleted;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.delete_all_chats() from public, anon;
grant execute on function public.delete_all_chats() to authenticated;

-- ── Hosted-answer usage ──────────────────────────────────────────────────

create table if not exists public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The first day of the month (UTC).
  period date not null,
  used integer not null default 0 check (used >= 0),
  primary key (user_id, period)
);
alter table public.usage enable row level security;
revoke all on public.usage from anon, authenticated;
grant select (period, used) on public.usage to authenticated;
drop policy if exists "own usage" on public.usage;
create policy "own usage" on public.usage
  for select to authenticated using (user_id = (select auth.uid()));

-- Called by the Worker (secret key) before each hosted answer: counts one if
-- the account has any left this month, in one statement so two answers at
-- once cannot both take the last one.
create or replace function public.use_answer(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q integer;
  u integer;
  p date := (date_trunc('month', now() at time zone 'utc'))::date;
begin
  select public.monthly_quota(e.plan, e.monthly_questions) into q from public.entitlements e where e.user_id = p_user;
  q := coalesce(q, 0);
  if q > 0 then
    insert into public.usage as x (user_id, period, used) values (p_user, p, 1)
    on conflict (user_id, period) do update set used = x.used + 1 where x.used < q
    returning x.used into u;
  end if;
  if u is null then
    select x.used into u from public.usage x where x.user_id = p_user and x.period = p;
    return jsonb_build_object('ok', false, 'used', coalesce(u, 0), 'quota', q, 'period', p);
  end if;
  return jsonb_build_object('ok', true, 'used', u, 'quota', q, 'period', p);
end $$;
revoke execute on function public.use_answer(uuid) from public, anon, authenticated;
grant execute on function public.use_answer(uuid) to service_role;

-- Gives one back when the AI failed before answering.
create or replace function public.refund_answer(p_user uuid, p_period date)
returns void language sql security definer set search_path = '' as $$
  update public.usage set used = greatest(used - 1, 0) where user_id = p_user and period = p_period
$$;
revoke execute on function public.refund_answer(uuid, date) from public, anon, authenticated;
grant execute on function public.refund_answer(uuid, date) to service_role;

-- ── Deleting an account ──────────────────────────────────────────────────

-- The extension empties the account's screenshot folder first (storage
-- objects cannot be deleted from SQL), then calls this. Chats, usage and
-- entitlements go with the user.
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  delete from auth.users where id = (select auth.uid());
end $$;
revoke execute on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

-- ── Screenshots ──────────────────────────────────────────────────────────

-- Private; paths are <user id>/<chat id>/<image id>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "read own screenshots" on storage.objects;
create policy "read own screenshots" on storage.objects
  for select to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "add own screenshots" on storage.objects;
create policy "add own screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.has_cloud()));
drop policy if exists "replace own screenshots" on storage.objects;
create policy "replace own screenshots" on storage.objects
  for update to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.has_cloud()));
drop policy if exists "delete own screenshots" on storage.objects;
create policy "delete own screenshots" on storage.objects
  for delete to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

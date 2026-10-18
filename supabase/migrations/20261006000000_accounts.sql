-- Juno: accounts, plans and subscriptions, cloud chats, hosted-answer
-- counts.
--
-- Run once, as is, in the Supabase dashboard's SQL editor (or with
-- `supabase db push`). Safe to run again, and it brings a project made with
-- an earlier version of this file up to date.
--
-- What it sets up:
--   plans          what each plan gives: hosted answers a month, cloud
--                  storage. 'free' is every account with nothing else.
--   entitlements   what you give an account by hand (set_entitlement): a
--                  plan, cloud storage, a monthly count of its own.
--   customers      which Stripe customer is which account.
--   subscriptions  Stripe subscriptions and passes as the Worker last saw
--                  them (its webhook). Never written by the apps.
--   account_of()   what an account gets, all of the above together (the
--                  most generous wins): the one place it is worked out, for
--                  row level security, the Worker's count and the apps'
--                  Account section (my_account()).
--   chats          cloud copies of saved chats, for accounts with cloud storage.
--                  Written only through push_chats (last write wins) and
--                  never really deleted by the apps: a deleted chat becomes
--                  a tombstone so other computers delete it too.
--   screenshots    a private storage bucket, one folder per account.
--   usage          hosted answers used per month, counted by the Worker.
--
-- Signed-in students reach their own rows with their session token and the
-- publishable key; row level security keeps each account to its own. The
-- secret key (the Worker's) bypasses it, so it is granted only what the
-- Worker uses. Every privilege is stated here, so the result is the same
-- whether the Data API's "Automatically expose new tables" is on or off.

grant usage on schema public to anon, authenticated, service_role;

-- ── Plans ────────────────────────────────────────────────────────────────

create table if not exists public.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{0,31}$'),
  name text not null,
  -- Hosted answers a month (0: none).
  monthly_questions integer not null check (monthly_questions >= 0),
  -- Cloud storage for chats and their screenshots.
  cloud boolean not null default false,
  -- When an account has more than one plan, the highest rank is the one shown.
  rank integer not null default 0
);
-- Your edits stay: a rerun only adds plans that are missing. Change a plan
-- in the Table Editor (or with update); Stripe prices name their plan in
-- their metadata (supabase/README.md).
insert into public.plans (id, name, monthly_questions, cloud, rank) values
  ('free', 'Free', 0, false, 0),
  ('plus', 'Plus', 3000, true, 10),
  ('unlimited', 'Unlimited', 100000, true, 100)
on conflict (id) do nothing;

alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated, service_role;
grant select on public.plans to anon, authenticated, service_role;
drop policy if exists "plans are public" on public.plans;
create policy "plans are public" on public.plans for select to anon, authenticated using (true);

-- ── Entitlements: what you give by hand ──────────────────────────────────

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  cloud boolean not null default false,
  plan text references public.plans (id),
  -- Overrides the plan's monthly count when set.
  monthly_questions integer check (monthly_questions >= 0),
  note text,
  updated_at timestamptz not null default now()
);
-- From the earlier version: plans were 'student' and 'unlimited', and
-- billing lived here.
alter table public.entitlements drop constraint if exists entitlements_plan_check;
update public.entitlements set plan = 'plus' where plan = 'student';
do $$ begin
  alter table public.entitlements add constraint entitlements_plan_fkey foreign key (plan) references public.plans (id);
exception when duplicate_object then null; end $$;
alter table public.entitlements drop column if exists stripe_customer, drop column if exists plan_renews_at;

alter table public.entitlements enable row level security;
revoke all on public.entitlements from anon, authenticated, service_role;
drop policy if exists "own entitlements" on public.entitlements;

-- For you, in the SQL editor: give an account cloud storage and/or a plan.
--   select public.set_entitlement('friend@example.com');                    -- cloud storage
--   select public.set_entitlement('friend@example.com', true, 'plus');      -- and Plus's hosted answers
--   select public.set_entitlement('friend@example.com', true, 'plus', 50);  -- and 50 a month instead
--   select public.set_entitlement('friend@example.com', false);             -- take it all away
-- The account must exist: they sign in once first. What they pay for
-- (subscriptions) is separate and never changed by this.
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
revoke execute on function public.set_entitlement(text, boolean, text, integer) from public, anon, authenticated, service_role;

-- ── Billing: Stripe customers, subscriptions and passes ──────────────────

create table if not exists public.customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer text not null unique,
  created_at timestamptz not null default now()
);
alter table public.customers enable row level security;
revoke all on public.customers from anon, authenticated, service_role;
grant select, insert, update, delete on public.customers to service_role;

create table if not exists public.subscriptions (
  -- Stripe's subscription id (sub_…), or for a pass its Checkout Session (cs_…).
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null references public.plans (id),
  kind text not null check (kind in ('subscription', 'pass')),
  -- Stripe's subscription status (active, trialing, past_due, canceled,
  -- unpaid, incomplete, …); for a pass, paid or refunded.
  status text not null,
  -- The price's lookup key (or id), for showing which one.
  price text,
  -- When the current period ends (renews, or stops): for a pass, when it runs out.
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- A pass's payment, to find it again when it is refunded.
  payment text,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_by_user on public.subscriptions (user_id);
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated, service_role;
grant select, insert, update on public.subscriptions to service_role;

-- ── What an account gets ─────────────────────────────────────────────────

-- Everything the account has, together: the free plan, what you gave it, and
-- what it pays for. The most generous of each wins. A subscription counts
-- while Stripe has it on (past_due too: Stripe retries a failed payment for
-- a while) and for three days past its period, so a late webhook never cuts
-- anyone off; a pass counts until it runs out.
create or replace function public.account_of(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  this_month date := (date_trunc('month', now() at time zone 'utc'))::date;
  grant_row public.entitlements;
  paid public.subscriptions;
  latest public.subscriptions;
  best public.plans;
  quota integer;
  cloud boolean;
  used integer;
begin
  select * into grant_row from public.entitlements e where e.user_id = p_user;
  select s.* into paid
    from public.subscriptions s join public.plans pl on pl.id = s.plan
   where s.user_id = p_user
     and ((s.kind = 'subscription' and s.status in ('active', 'trialing', 'past_due')
           and s.period_end > now() - interval '3 days')
       or (s.kind = 'pass' and s.status = 'paid' and s.period_end > now()))
   order by pl.rank desc, s.period_end desc nulls first
   limit 1;
  select s.* into latest from public.subscriptions s where s.user_id = p_user order by s.updated_at desc limit 1;

  select pl.* into best from public.plans pl
   where pl.id in ('free', coalesce(grant_row.plan, 'free'), coalesce(paid.plan, 'free'))
   order by pl.rank desc limit 1;

  select max(x.q), bool_or(x.c) into quota, cloud from (
    select pl.monthly_questions as q, pl.cloud as c from public.plans pl where pl.id in ('free', coalesce(paid.plan, 'free'))
    union all
    select coalesce(grant_row.monthly_questions, pl.monthly_questions), grant_row.cloud or pl.cloud
      from public.plans pl where grant_row.user_id is not null and pl.id = coalesce(grant_row.plan, 'free')
  ) x;

  select u.used into used from public.usage u where u.user_id = p_user and u.period = this_month;

  return jsonb_build_object(
    'plan', coalesce(best.id, 'free'),
    'plan_name', coalesce(best.name, 'Free'),
    'cloud', coalesce(cloud, false),
    'quota', coalesce(quota, 0),
    'used', coalesce(used, 0),
    'period', this_month,
    -- The paid plan running, else the latest one (to say a payment failed or it ended).
    'billing', (select case when b.id is null then null else jsonb_build_object(
        'kind', b.kind, 'status', b.status, 'plan', b.plan, 'active', paid.id is not null,
        'period_end', b.period_end, 'cancel_at_period_end', b.cancel_at_period_end) end
      from (select coalesce(paid.id, latest.id) as id, coalesce(paid.kind, latest.kind) as kind,
                   coalesce(paid.status, latest.status) as status, coalesce(paid.plan, latest.plan) as plan,
                   coalesce(paid.period_end, latest.period_end) as period_end,
                   coalesce(paid.cancel_at_period_end, latest.cancel_at_period_end) as cancel_at_period_end) b),
    'customer', exists (select 1 from public.customers c where c.user_id = p_user)
  );
end $$;
revoke execute on function public.account_of(uuid) from public, anon, authenticated;
grant execute on function public.account_of(uuid) to service_role;

-- The signed-in account's own (the apps' Account section).
create or replace function public.my_account()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  return public.account_of((select auth.uid()));
end $$;
revoke execute on function public.my_account() from public, anon, service_role;
grant execute on function public.my_account() to authenticated;

-- Whether the signed-in account has cloud storage, for the policies below.
create or replace function public.has_cloud()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((public.account_of((select auth.uid())) ->> 'cloud')::boolean, false)
$$;
revoke execute on function public.has_cloud() from public, anon, service_role;
grant execute on function public.has_cloud() to authenticated;

-- From the earlier version: worked out in account_of now.
drop function if exists public.monthly_quota(text, integer);

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
-- Read directly; written only through push_chats and delete_all_chats, which
-- enforce what a policy can't (how much an account may keep).
revoke all on public.chats from anon, authenticated, service_role;
grant select on public.chats to authenticated;
drop policy if exists "read own chats" on public.chats;
create policy "read own chats" on public.chats
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "add own chats" on public.chats;
drop policy if exists "change own chats" on public.chats;

-- What one account may keep in the cloud: far more than the apps ever make
-- (they keep at most 100 chats a computer), far less than would fill the project.
create or replace function public.cloud_limits()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('chats', 5000, 'chat_bytes', 300000000, 'screenshots', 20000, 'screenshot_bytes', 2000000000)
$$;
revoke execute on function public.cloud_limits() from public, anon, authenticated, service_role;

-- Saves up to 50 chats (or tombstones) at once. Saving needs cloud storage;
-- a deletion never does, so chats can always be removed. A chat older than
-- what is already here changes nothing; a deletion always takes effect (and
-- counts as newer, whatever the deleting computer's clock said). Returns how
-- many rows changed.
create or replace function public.push_chats(p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  lim jsonb := public.cloud_limits();
  n integer;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'push_chats takes an array of at most 50 chats' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) as r (deleted boolean) where not coalesce(r.deleted, false))
     and not public.has_cloud() then
    raise exception 'This account has no cloud storage' using errcode = '42501';
  end if;
  if (select count(*) from public.chats c where c.user_id = uid)
       + (select count(*) from jsonb_to_recordset(p_rows) as r (id text)
           where not exists (select 1 from public.chats c where c.user_id = uid and c.id = r.id)) > (lim ->> 'chats')::bigint
     or (select coalesce(sum(pg_column_size(c.data)), 0) from public.chats c where c.user_id = uid) > (lim ->> 'chat_bytes')::bigint then
    raise exception 'Cloud storage is full' using errcode = '54000';
  end if;
  insert into public.chats as c (user_id, id, updated_ms, deleted, data, synced_at)
  select uid, r.id, r.updated_ms, coalesce(r.deleted, false),
         case when coalesce(r.deleted, false) then null else r.data end, clock_timestamp()
  from jsonb_to_recordset(p_rows) as r (id text, updated_ms bigint, deleted boolean, data jsonb)
  -- A deletion of a chat the cloud never had: nothing to tell anyone.
  where not coalesce(r.deleted, false) or exists (select 1 from public.chats x where x.user_id = uid and x.id = r.id)
  on conflict (user_id, id) do update
    set updated_ms = case when excluded.deleted then greatest(c.updated_ms + 1, excluded.updated_ms) else excluded.updated_ms end,
        deleted = excluded.deleted, data = excluded.data, synced_at = clock_timestamp()
    where excluded.updated_ms > c.updated_ms or (excluded.deleted and not c.deleted);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.push_chats(jsonb) from public, anon, service_role;
grant execute on function public.push_chats(jsonb) to authenticated;

-- "Delete all chats": every chat of this account becomes a tombstone.
create or replace function public.delete_all_chats()
returns integer language plpgsql security definer set search_path = '' as $$
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
revoke execute on function public.delete_all_chats() from public, anon, service_role;
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
revoke all on public.usage from anon, authenticated, service_role;
drop policy if exists "own usage" on public.usage;

-- Called by the Worker (secret key) before each hosted answer: counts one if
-- the account has any left this month, in one statement so two answers at
-- once cannot both take the last one.
create or replace function public.use_answer(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q integer := coalesce((public.account_of(p_user) ->> 'quota')::integer, 0);
  u integer;
  p date := (date_trunc('month', now() at time zone 'utc'))::date;
begin
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

-- The apps have the Worker close the account's Stripe customer first (which
-- ends its subscriptions), empty its screenshot folder (storage objects
-- cannot be deleted from SQL), then call this. Everything else goes with
-- the user. Refused until both are done: an account deleted with billing
-- open would keep being charged with no way to cancel, and screenshots left
-- behind would belong to nobody.
create or replace function public.delete_me()
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from public.customers c where c.user_id = uid) then
    raise exception 'Billing is still open: close it first' using errcode = '55000';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'screenshots' and (storage.foldername(o.name))[1] = uid::text) then
    raise exception 'Screenshots are still stored: delete them first' using errcode = '55000';
  end if;
  delete from auth.users where id = uid;
end $$;
revoke execute on function public.delete_me() from public, anon, service_role;
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
-- Whether the signed-in account may store another screenshot: cloud storage,
-- and room left (cloud_limits()).
create or replace function public.screenshot_room()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_cloud() and count(*) < (public.cloud_limits() ->> 'screenshots')::bigint
     and coalesce(sum((o.metadata ->> 'size')::bigint), 0) < (public.cloud_limits() ->> 'screenshot_bytes')::bigint
  from storage.objects o
  where o.bucket_id = 'screenshots' and (storage.foldername(o.name))[1] = (select auth.uid())::text
$$;
revoke execute on function public.screenshot_room() from public, anon, service_role;
grant execute on function public.screenshot_room() to authenticated;

drop policy if exists "add own screenshots" on storage.objects;
create policy "add own screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.screenshot_room()));
drop policy if exists "replace own screenshots" on storage.objects;
create policy "replace own screenshots" on storage.objects
  for update to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.has_cloud()));
drop policy if exists "delete own screenshots" on storage.objects;
create policy "delete own screenshots" on storage.objects
  for delete to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

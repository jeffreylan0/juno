-- Exercises the migration as the API roles would. Any failed check raises.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'c@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'd@example.com');
select public.set_entitlement('A@example.com');                   -- cloud only
select public.set_entitlement('b@example.com', false, null, 2);   -- 2 hosted answers, no cloud

-- ── A: cloud storage ──
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select pg_temp.check((public.my_account() ->> 'cloud')::boolean, 'A has cloud storage');
select pg_temp.check(public.my_account() ->> 'plan' = 'free' and (public.my_account() ->> 'quota')::int = 0, 'A is on the free plan');
select pg_temp.check((select count(*) from public.plans) >= 3, 'plans are public');
select pg_temp.check(public.push_chats('[{"id":"c1","updated_ms":100,"data":{"title":"one"}},{"id":"c2","updated_ms":100,"data":{"title":"two"}}]') = 2, 'A pushes two');
select pg_temp.check(public.push_chats('[{"id":"c1","updated_ms":50,"data":{"title":"older"}}]') = 0, 'older write loses');
select pg_temp.check(public.push_chats('[{"id":"c1","updated_ms":100,"data":{"title":"same"}}]') = 0, 'same-time write loses');
select pg_temp.check(public.push_chats('[{"id":"c1","updated_ms":200,"data":{"title":"newer"}}]') = 1, 'newer write wins');
select pg_temp.check((select data->>'title' from public.chats where id = 'c1') = 'newer', 'newer data kept');
select pg_temp.check(public.push_chats('[{"id":"c2","updated_ms":300,"deleted":true,"data":{"x":1}}]') = 1, 'tombstone');
select pg_temp.check((select deleted and data is null from public.chats where id = 'c2'), 'tombstone has no data');
do $$ begin
  perform public.push_chats('[{"id":"bad id!","updated_ms":1,"data":{}}]');
  raise exception 'FAILED: bad id accepted';
exception when check_violation then null; end $$;
do $$ begin
  perform public.push_chats((select jsonb_agg(jsonb_build_object('id','x'||g,'updated_ms',1,'data','{}'::jsonb)) from generate_series(1,51) g));
  raise exception 'FAILED: 51 rows accepted';
exception when invalid_parameter_value then null; end $$;
-- Not through the function either: direct writes obey the same policies, and delete is not granted.
do $$ begin
  delete from public.chats where id = 'c1';
  raise exception 'FAILED: delete allowed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.chats (user_id, id, updated_ms, data) values ('00000000-0000-0000-0000-00000000000b', 'evil', 1, '{}');
  raise exception 'FAILED: wrote into another account';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.use_answer('00000000-0000-0000-0000-00000000000a');
  raise exception 'FAILED: student can count answers';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.set_entitlement('a@example.com', true, 'unlimited');
  raise exception 'FAILED: student can grant itself a plan';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update public.entitlements set plan = 'unlimited';
  raise exception 'FAILED: student can change its entitlement';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.entitlements;
  raise exception 'FAILED: entitlements readable';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.subscriptions;
  raise exception 'FAILED: subscriptions readable';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.customers;
  raise exception 'FAILED: customers readable';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.subscriptions (id, user_id, plan, kind, status) values ('sub_x', '00000000-0000-0000-0000-00000000000a', 'plus', 'subscription', 'active');
  raise exception 'FAILED: student can give itself a subscription';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.account_of('00000000-0000-0000-0000-00000000000b');
  raise exception 'FAILED: student can read another account';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update public.plans set monthly_questions = 999999;
  raise exception 'FAILED: student can change a plan';
exception when insufficient_privilege then null; end $$;
-- Screenshots: own folder only.
insert into storage.objects (bucket_id, name) values ('screenshots', '00000000-0000-0000-0000-00000000000a/c1/img1');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('screenshots', '00000000-0000-0000-0000-00000000000b/c1/img1');
  raise exception 'FAILED: wrote into another folder';
exception when insufficient_privilege then null; end $$;

-- ── B: no cloud storage, a plan ──
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select pg_temp.check((select count(*) from public.chats) = 0, 'B sees none of A''s chats');
do $$ begin
  perform public.push_chats('[{"id":"b1","updated_ms":1,"data":{}}]');
  raise exception 'FAILED: B saved without cloud storage';
exception when insufficient_privilege then null; end $$;
select pg_temp.check(public.push_chats('[{"id":"b1","updated_ms":1,"deleted":true}]') = 1, 'B can still delete (tombstone)');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('screenshots', '00000000-0000-0000-0000-00000000000b/c1/img1');
  raise exception 'FAILED: B uploaded without cloud storage';
exception when insufficient_privilege then null; end $$;
select pg_temp.check((select count(*) from storage.objects) = 0, 'B sees none of A''s screenshots');

-- ── The Worker (secret key) counts hosted answers ──
reset role;
set role service_role;
select pg_temp.check((public.use_answer('00000000-0000-0000-0000-00000000000b')->>'ok')::boolean, 'B answer 1');
select pg_temp.check((public.use_answer('00000000-0000-0000-0000-00000000000b')->>'used')::int = 2, 'B answer 2');
select pg_temp.check(not (public.use_answer('00000000-0000-0000-0000-00000000000b')->>'ok')::boolean, 'B over quota');
select public.refund_answer('00000000-0000-0000-0000-00000000000b', (date_trunc('month', now() at time zone 'utc'))::date);
select pg_temp.check((public.use_answer('00000000-0000-0000-0000-00000000000b')->>'ok')::boolean, 'refund gives one back');
select pg_temp.check(not (public.use_answer('00000000-0000-0000-0000-00000000000a')->>'ok')::boolean, 'A has no plan');
select pg_temp.check(not (public.use_answer('00000000-0000-0000-0000-0000000000ff')->>'ok')::boolean, 'unknown user has none');

-- ── The Worker's own reads and writes (billing.ts), and nothing more ──
reset role;
set role service_role;
select pg_temp.check((select count(*) from public.plans where id = 'plus') = 1, 'the Worker reads plans');
insert into public.customers (user_id, stripe_customer) values ('00000000-0000-0000-0000-00000000000d', 'cus_d1')
  on conflict (user_id) do update set stripe_customer = excluded.stripe_customer;
insert into public.customers (user_id, stripe_customer) values ('00000000-0000-0000-0000-00000000000d', 'cus_d2')
  on conflict (user_id) do update set stripe_customer = excluded.stripe_customer;
select pg_temp.check((select user_id from public.customers where stripe_customer = 'cus_d2') = '00000000-0000-0000-0000-00000000000d', 'the Worker upserts and finds a customer');
delete from public.customers where user_id = '00000000-0000-0000-0000-00000000000d';
select pg_temp.check(not exists (select 1 from public.customers where user_id = '00000000-0000-0000-0000-00000000000d'), 'the Worker removes a customer');
do $$ begin
  perform 1 from public.chats;
  raise exception 'FAILED: the Worker reads chats';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.usage;
  raise exception 'FAILED: the Worker reads usage directly';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.entitlements;
  raise exception 'FAILED: the Worker reads entitlements directly';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.set_entitlement('b@example.com', true, 'unlimited');
  raise exception 'FAILED: the Worker can give a plan';
exception when insufficient_privilege then null; end $$;

-- ── Subscriptions and passes (the Worker's webhook writes them) ──
reset role;
set role service_role;
insert into public.customers (user_id, stripe_customer) values ('00000000-0000-0000-0000-00000000000c', 'cus_c');
create or replace function pg_temp.acct(id text) returns jsonb language sql as $$
  select public.account_of(('00000000-0000-0000-0000-00000000000' || id)::uuid) $$;
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'free' and (pg_temp.acct('c') ->> 'customer')::boolean, 'C a customer, still free');
insert into public.subscriptions (id, user_id, plan, kind, status, price, period_end)
values ('sub_c', '00000000-0000-0000-0000-00000000000c', 'plus', 'subscription', 'active', 'plus_monthly', now() + interval '20 days');
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'plus' and (pg_temp.acct('c') ->> 'quota')::int = 600 and (pg_temp.acct('c') ->> 'cloud')::boolean, 'C subscribed: Plus');
insert into public.subscriptions (id, user_id, plan, kind, status, price, period_end)
values ('sub_c', '00000000-0000-0000-0000-00000000000c', 'plus', 'subscription', 'active', 'plus_monthly', now() + interval '25 days')
on conflict (id) do update set status = excluded.status, period_end = excluded.period_end, updated_at = now();
select pg_temp.check((select period_end > now() + interval '24 days' from public.subscriptions where id = 'sub_c'), 'the webhook upserts a subscription');
select pg_temp.check((pg_temp.acct('c') -> 'billing' ->> 'active')::boolean and pg_temp.acct('c') -> 'billing' ->> 'kind' = 'subscription', 'C billing active');
update public.subscriptions set status = 'past_due' where id = 'sub_c';
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'plus', 'a failed payment keeps Plus while Stripe retries');
update public.subscriptions set status = 'active', period_end = now() - interval '1 day' where id = 'sub_c';
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'plus', 'a late renewal webhook cuts no one off');
update public.subscriptions set period_end = now() - interval '5 days' where id = 'sub_c';
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'free', 'long past its period: over');
update public.subscriptions set status = 'canceled', period_end = now() + interval '1 day' where id = 'sub_c';
select pg_temp.check(pg_temp.acct('c') ->> 'plan' = 'free', 'canceled: free');
select pg_temp.check(not (pg_temp.acct('c') -> 'billing' ->> 'active')::boolean and pg_temp.acct('c') -> 'billing' ->> 'status' = 'canceled', 'canceled shows as ended');
insert into public.subscriptions (id, user_id, plan, kind, status, period_end)
values ('cs_d', '00000000-0000-0000-0000-00000000000d', 'plus', 'pass', 'paid', now() + interval '120 days');
select pg_temp.check(pg_temp.acct('d') ->> 'plan' = 'plus' and pg_temp.acct('d') -> 'billing' ->> 'kind' = 'pass', 'D on a pass');
select pg_temp.check((public.use_answer('00000000-0000-0000-0000-00000000000d') ->> 'quota')::int = 600, 'a pass counts answers');
update public.subscriptions set status = 'refunded' where id = 'cs_d';
select pg_temp.check(pg_temp.acct('d') ->> 'plan' = 'free', 'refunded pass: free');
update public.subscriptions set status = 'paid', period_end = now() - interval '1 minute' where id = 'cs_d';
select pg_temp.check(pg_temp.acct('d') ->> 'plan' = 'free', 'a pass that ran out: free');
reset role;
select public.set_entitlement('d@example.com', false, 'unlimited');
update public.subscriptions set period_end = now() + interval '1 day' where id = 'cs_d';
set role service_role;
select pg_temp.check(pg_temp.acct('d') ->> 'plan' = 'unlimited' and (pg_temp.acct('d') ->> 'quota')::int = 100000, 'the most generous plan wins');

-- ── B reads its usage; deletes all chats; A deletes the account ──
reset role;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select pg_temp.check((public.my_account() ->> 'used')::int = 2, 'B reads own usage');
select pg_temp.check((public.my_account() ->> 'quota')::int = 2 and not (public.my_account() ->> 'cloud')::boolean, 'B: two answers, no cloud');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select pg_temp.check(public.delete_all_chats() = 1, 'A deletes all (one live chat)');
select pg_temp.check((select bool_and(deleted) from public.chats), 'all tombstones');
select pg_temp.check((select updated_ms from public.chats where id = 'c1') > 200, 'tombstone is newer');
select public.delete_me();
reset role;
select pg_temp.check(not exists (select 1 from auth.users where email = 'a@example.com'), 'A gone');
select pg_temp.check(not exists (select 1 from public.chats where user_id = '00000000-0000-0000-0000-00000000000a'), 'A''s chats gone');
select pg_temp.check(not exists (select 1 from public.entitlements where user_id = '00000000-0000-0000-0000-00000000000a'), 'A''s entitlement gone');
set role anon;
do $$ begin
  perform 1 from public.chats;
  raise exception 'FAILED: anon reads chats';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.delete_me();
  raise exception 'FAILED: anon may call delete_me';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.my_account();
  raise exception 'FAILED: anon may call my_account';
exception when insufficient_privilege then null; end $$;
reset role;
select 'all checks passed' as result;

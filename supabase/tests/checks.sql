-- Exercises the migration as the API roles would. Any failed check raises.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
select public.set_entitlement('A@example.com');                       -- cloud only
select public.set_entitlement('b@example.com', false, 'student', 2);  -- 2 hosted answers, no cloud

-- ── A: cloud storage ──
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a"}';
select pg_temp.check((select cloud from public.entitlements) = true, 'A reads own entitlement');
select pg_temp.check((select count(*) from public.entitlements) = 1, 'A sees only own entitlement');
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
  perform stripe_customer from public.entitlements;
  raise exception 'FAILED: stripe_customer readable';
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

-- ── B reads its usage; deletes all chats; A deletes the account ──
reset role;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b"}';
select pg_temp.check((select used from public.usage) = 2, 'B reads own usage');
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
reset role;
select 'all checks passed' as result;

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select has_table('public', 'captures', 'captures table exists');
select has_table('public', 'capture_assets', 'capture_assets table exists');
select has_table('public', 'capture_analyses', 'capture_analyses table exists');
select has_table('public', 'capture_jobs', 'capture_jobs table exists');
select col_is_fk('public', 'capture_assets', 'capture_id', 'assets belong to captures');
select col_is_fk('public', 'capture_analyses', 'capture_id', 'analyses belong to captures');
select col_is_fk('public', 'capture_jobs', 'capture_id', 'jobs belong to captures');
select has_index('public', 'captures', 'captures_provider_message_uidx', 'provider idempotency index exists');
select has_index('public', 'captures', 'captures_user_chronological_idx', 'chronological capture index exists');
select has_index('public', 'capture_jobs', 'capture_jobs_pending_idx', 'pending-job index exists');
select is((select public from storage.buckets where id = 'capture-assets'), false, 'capture-assets bucket is private');
select is((select count(*)::integer from storage.buckets where id = 'capture-assets'), 1, 'migration leaves exactly one private bucket');

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-one@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'owner-two@example.test');

insert into public.captures
  (id, user_id, capture_channel, external_message_id, captured_at, raw_payload)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'whatsapp', 'SM-unique', now(), '{}'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', 'email', null, now(), '{}'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '22222222-2222-2222-2222-222222222222', 'email', null, now(), '{}');

select throws_ok(
  $$insert into public.captures (user_id, capture_channel, external_message_id, captured_at) values
    ('22222222-2222-2222-2222-222222222222', 'whatsapp', 'SM-unique', now())$$,
  '23505', null, 'channel and external message id are idempotent'
);
select lives_ok(
  $$insert into public.captures (user_id, capture_channel, external_message_id, captured_at) values
    ('11111111-1111-1111-1111-111111111111', 'email', null, now())$$,
  'captures without external ids remain distinct'
);

insert into public.capture_assets (id, capture_id, storage_path, filename)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'captures/11111111-1111-1111-1111-111111111111/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1/file.jpg', 'file.jpg');
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, model_id, prompt_version, pipeline_version)
values ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'intent', 'succeeded', '{}', '{}', 'test-model', 'v1', 'v1');
insert into public.capture_jobs (id, capture_id, job_type)
values ('dddddddd-dddd-dddd-dddd-ddddddddddd1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'intent_analysis');
insert into storage.objects (bucket_id, name, owner_id)
values
  ('capture-assets', 'captures/11111111-1111-1111-1111-111111111111/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1/file.jpg', '11111111-1111-1111-1111-111111111111'),
  ('capture-assets', 'captures/22222222-2222-2222-2222-222222222222/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2/private.jpg', '22222222-2222-2222-2222-222222222222');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select is((select count(*)::integer from public.captures), 2, 'owner sees only their captures');
select is((select count(*)::integer from public.capture_assets), 1, 'owner sees their assets');
select is((select count(*)::integer from public.capture_analyses), 1, 'owner sees their analyses');
select is((select count(*)::integer from public.capture_jobs), 1, 'owner sees their jobs');
select is((select count(*)::integer from storage.objects where bucket_id = 'capture-assets'), 1,
  'owner sees only storage under an owned capture path');
select is((select count(*)::integer from storage.objects
  where name like 'captures/22222222-2222-2222-2222-222222222222/%'), 0,
  'asset path owned by another user is unreadable');

select throws_ok(
  $$insert into public.capture_analyses
    (capture_id, analysis_type, status, input_snapshot, result, model_id, prompt_version, pipeline_version)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'intent', 'succeeded', '{}', '{}', 'x', 'v1', 'v1')$$,
  '42501', null, 'authenticated users cannot insert analyses'
);
select throws_ok(
  $$update public.capture_analyses set model_id = 'changed' where id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'$$,
  '42501', null, 'authenticated analyses are append-only'
);
select throws_ok(
  $$delete from public.capture_analyses where id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'$$,
  '42501', null, 'authenticated users cannot delete analyses directly'
);
select throws_ok(
  $$insert into public.capture_jobs (capture_id, job_type) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'intent_analysis')$$,
  '42501', null, 'authenticated users cannot insert jobs'
);
select throws_ok(
  $$update public.capture_jobs set status = 'processing' where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1'$$,
  '42501', null, 'authenticated users cannot mutate jobs'
);

select lives_ok(
  $$delete from public.captures where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'$$,
  'owner can permanently delete their capture'
);

reset role;
select is((select count(*)::integer from public.captures where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 0,
  'owned capture was deleted');
select is((select count(*)::integer from public.capture_assets where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 0,
  'capture delete cascades to assets');
select is((select count(*)::integer from public.capture_analyses where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 0,
  'capture delete cascades to analyses');
select is((select count(*)::integer from public.capture_jobs where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 0,
  'capture delete cascades to jobs');

set local role anon;
select is((select count(*)::integer from storage.objects where bucket_id = 'capture-assets'), 0,
  'unsigned public requests cannot read capture assets');
select throws_ok(
  $$select count(*) from public.captures$$,
  '42501', null, 'unsigned public requests have no capture table privilege'
);

reset role;
select is((select relrowsecurity from pg_class where oid = 'public.captures'::regclass), true, 'captures has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.capture_assets'::regclass), true, 'assets has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.capture_analyses'::regclass), true, 'analyses has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.capture_jobs'::regclass), true, 'jobs has RLS enabled');
select is((select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'capture_analyses'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 0, 'analyses have no authenticated mutation policy');
select is((select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'capture_jobs'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 0, 'jobs have no authenticated mutation policy');
select is((select count(*)::integer from information_schema.tables where table_schema = 'public'
  and table_name in ('captures', 'capture_assets', 'capture_analyses', 'capture_jobs')), 4,
  'full migrated schema remains complete');

select * from finish();
rollback;

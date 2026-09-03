begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

insert into auth.users (id, email)
values ('33333333-3333-3333-3333-333333333333', 'atomic-owner@example.test');

select has_function(
  'public',
  'persist_capture_with_intent_job',
  array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamp with time zone', 'jsonb', 'jsonb'],
  'AC1 atomic persistence function exists'
);
select function_privs_are(
  'public',
  'persist_capture_with_intent_job',
  array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamp with time zone', 'jsonb', 'jsonb'],
  'anon',
  array[]::text[],
  'AC5 anonymous clients cannot execute privileged persistence'
);
select function_privs_are(
  'public',
  'persist_capture_with_intent_job',
  array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamp with time zone', 'jsonb', 'jsonb'],
  'authenticated',
  array[]::text[],
  'AC5 authenticated clients cannot execute privileged persistence'
);

select lives_ok(
  $$select * from public.persist_capture_with_intent_job(
    '33333333-3333-3333-3333-333333333333', 'whatsapp', 'SM-atomic', 'mixed',
    'Keep https://example.test/item', 'for the trip', null, '2026-09-03T01:30:00Z',
    '{"nested":{"untouched":true},"sequence":[1,2,3]}',
    '[{"id":"media-1","fileName":"photo.jpg","contentType":"image/jpeg","providerIndex":0}]'
  )$$,
  'AC1 capture, assets and initial job commit through one call'
);
select is(
  (select count(*)::integer from public.captures where external_message_id = 'SM-atomic'),
  1,
  'AC1 exactly one capture is committed'
);
select is(
  (select raw_payload from public.captures where external_message_id = 'SM-atomic'),
  '{"nested":{"untouched":true},"sequence":[1,2,3]}'::jsonb,
  'AC1 raw provider payload remains deeply unchanged'
);
select is(
  (select count(*)::integer from public.capture_assets a join public.captures c on c.id = a.capture_id
    where c.external_message_id = 'SM-atomic'),
  1,
  'AC1 asset metadata is committed with the capture'
);
select is(
  (select metadata from public.capture_assets a join public.captures c on c.id = a.capture_id
    where c.external_message_id = 'SM-atomic'),
  '{"id":"media-1","fileName":"photo.jpg","contentType":"image/jpeg","providerIndex":0}'::jsonb,
  'AC1 asset metadata remains deeply unchanged'
);
select is(
  (select count(*)::integer from public.capture_jobs j join public.captures c on c.id = j.capture_id
    where c.external_message_id = 'SM-atomic' and j.job_type = 'intent_analysis' and j.status = 'pending'),
  1,
  'AC1 exactly one pending intent-analysis job is committed'
);

select lives_ok(
  $$select * from public.persist_capture_with_intent_job(
    '33333333-3333-3333-3333-333333333333', 'whatsapp', 'SM-atomic', 'text',
    'retry body', null, null, '2026-09-03T01:31:00Z', '{}', '[]'
  )$$,
  'AC3 a provider retry resolves successfully'
);
select is(
  (select count(*)::integer from public.captures where external_message_id = 'SM-atomic'),
  1,
  'AC3 a provider retry reuses the original capture'
);
select is(
  (select count(*)::integer from public.capture_jobs j join public.captures c on c.id = j.capture_id
    where c.external_message_id = 'SM-atomic' and j.job_type = 'intent_analysis'),
  1,
  'AC3 a provider retry does not create another initial job'
);

select lives_ok(
  $$select * from public.persist_capture_with_intent_job(
    '33333333-3333-3333-3333-333333333333', 'email', null, 'text',
    'first action', null, null, '2026-09-03T01:32:00Z', '{}', '[]'
  ); select * from public.persist_capture_with_intent_job(
    '33333333-3333-3333-3333-333333333333', 'email', null, 'text',
    'second action', null, null, '2026-09-03T01:33:00Z', '{}', '[]'
  )$$,
  'AC4 separate captures without external ids both succeed'
);
select is(
  (select count(*)::integer from public.captures where capture_channel = 'email' and external_message_id is null),
  2,
  'AC4 missing external ids do not deduplicate unrelated captures'
);
select is(
  (select count(*)::integer from public.capture_jobs j join public.captures c on c.id = j.capture_id
    where c.capture_channel = 'email' and c.external_message_id is null and j.job_type = 'intent_analysis'),
  2,
  'AC4 each unrelated capture has its own pending intent job'
);

create function pg_temp.fail_selected_intent_job()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.captures
    where id = new.capture_id and external_message_id = 'SM-force-rollback'
  ) then
    raise exception 'injected initial job failure';
  end if;
  return new;
end;
$$;
create trigger fail_selected_intent_job
before insert on public.capture_jobs
for each row execute function pg_temp.fail_selected_intent_job();

select throws_ok(
  $$select * from public.persist_capture_with_intent_job(
    '33333333-3333-3333-3333-333333333333', 'whatsapp', 'SM-force-rollback', 'attachment',
    null, null, null, '2026-09-03T01:34:00Z', '{"must":"rollback"}',
    '[{"id":"rollback-asset"}]'
  )$$,
  'P0001',
  'injected initial job failure',
  'AC2 an initial-job failure aborts the atomic call'
);
select is(
  (select count(*)::integer from public.captures where external_message_id = 'SM-force-rollback'),
  0,
  'AC2 failed initial-job creation leaves no partial capture'
);
select is(
  (select count(*)::integer from public.capture_assets where metadata ->> 'id' = 'rollback-asset'),
  0,
  'AC2 failed initial-job creation leaves no partial asset'
);

select * from finish();
rollback;

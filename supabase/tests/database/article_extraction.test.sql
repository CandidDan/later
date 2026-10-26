begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(31);

select has_function('public', 'claim_article_extraction_job', array[]::text[],
  'article extraction has a dedicated claim RPC');
select has_function('public', 'finish_article_extraction_attempt', array['uuid','integer','jsonb','text'],
  'article extraction has a fenced finalization RPC');
select ok(not has_function_privilege('anon', 'public.claim_article_extraction_job()', 'execute'),
  'anonymous callers cannot claim article work');
select ok(not has_function_privilege('authenticated',
  'public.finish_article_extraction_attempt(uuid,integer,jsonb,text)', 'execute'),
  'users cannot publish article extractions');
select ok(not has_table_privilege('authenticated', 'public.capture_article_extractions', 'insert'),
  'users cannot insert article extractions');

insert into auth.users (id, email) values
  ('24242424-0000-4000-8000-000000000001', 'article-owner@example.test'),
  ('24242424-0000-4000-8000-000000000002', 'article-other@example.test');
insert into public.captures (id, user_id, capture_channel, capture_kind, raw_text, captured_at, raw_payload)
values
  ('24242424-0000-4000-8000-000000000011', '24242424-0000-4000-8000-000000000001',
   'whatsapp', 'link', 'https://example.com/essay', now(), '{}'),
  ('24242424-0000-4000-8000-000000000012', '24242424-0000-4000-8000-000000000001',
   'whatsapp', 'link', 'https://www.youtube.com/watch?v=abcdefgh', now(), '{}'),
  ('24242424-0000-4000-8000-000000000013', '24242424-0000-4000-8000-000000000001',
   'whatsapp', 'link', 'https://example.com/unreachable', now(), '{}');

-- AC1: a resolved article source analysis enqueues exactly one extraction job.
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, confidence, model_id,
   prompt_version, pipeline_version)
values ('24242424-0000-4000-8000-000000000021', '24242424-0000-4000-8000-000000000011',
  'source_resolution', 'succeeded', '{}',
  '{"status":"resolved","sourceType":"article","title":"Essay","creator":"Ada","canonicalUrl":"https://example.com/essay","durationSeconds":null,"transcriptUrl":null}',
  0.9, null, 'source-direct-v0.1', 'source-resolution-pipeline-v0.1');
select is((select count(*) from public.capture_jobs where job_type = 'article_extraction'
  and source_analysis_id = '24242424-0000-4000-8000-000000000021'), 1::bigint,
  'AC1 a resolved article enqueues exactly one article_extraction job');
insert into public.capture_jobs (capture_id, job_type, source_analysis_id)
  values ('24242424-0000-4000-8000-000000000011', 'article_extraction',
    '24242424-0000-4000-8000-000000000021')
  on conflict do nothing;
select is((select count(*) from public.capture_jobs where job_type = 'article_extraction'
  and source_analysis_id = '24242424-0000-4000-8000-000000000021'), 1::bigint,
  'AC1 re-inserting the job for the same source analysis does not duplicate it');
select throws_ok($$insert into public.capture_jobs (capture_id, job_type, source_analysis_id)
  values ('24242424-0000-4000-8000-000000000011', 'article_extraction',
    '24242424-0000-4000-8000-000000000021')$$, '23505', null,
  'AC1 the database itself refuses a second job for one source analysis');
select is((select count(*) from public.capture_article_extractions
  where capture_id = '24242424-0000-4000-8000-000000000011'), 0::bigint,
  'AC1 nothing is recorded for an article before it is extracted');

-- AC2: every other published source outcome is recorded unsupported/not_an_article, never fetched.
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, confidence, model_id,
   prompt_version, pipeline_version, error_code)
values
  ('24242424-0000-4000-8000-000000000022', '24242424-0000-4000-8000-000000000012',
   'source_resolution', 'succeeded', '{}',
   '{"status":"resolved","sourceType":"youtube_video","title":"Clip","creator":"Ada","canonicalUrl":"https://www.youtube.com/watch?v=abcdefgh","durationSeconds":60,"transcriptUrl":null}',
   0.9, null, 'source-direct-v0.1', 'source-resolution-pipeline-v0.1', null),
  ('24242424-0000-4000-8000-000000000023', '24242424-0000-4000-8000-000000000012',
   'source_resolution', 'succeeded', '{}',
   '{"status":"unresolved","sourceType":null,"title":null,"creator":null,"canonicalUrl":null,"durationSeconds":null,"transcriptUrl":null}',
   0.2, null, 'source-direct-v0.1', 'source-resolution-pipeline-v0.1', null),
  ('24242424-0000-4000-8000-000000000024', '24242424-0000-4000-8000-000000000012',
   'source_resolution', 'failed', '{}', null, null, null,
   'source-direct-v0.1', 'source-resolution-pipeline-v0.1', 'provider_unavailable');
select is((select count(*) from public.capture_jobs where job_type = 'article_extraction'
  and capture_id = '24242424-0000-4000-8000-000000000012'), 0::bigint,
  'AC2 a non-article or unresolved source enqueues no fetch');
select is((select count(*) from public.capture_article_extractions
  where capture_id = '24242424-0000-4000-8000-000000000012'
    and status = 'unsupported' and reason = 'not_an_article' and paragraphs is null), 2::bigint,
  'AC2 the video and the unresolved source are each recorded unsupported/not_an_article');
select is((select count(*) from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000024'), 0::bigint,
  'AC2 a failed (still retrying) source attempt is not mistaken for a verdict');
select is((select source_url from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000022'),
  'https://www.youtube.com/watch?v=abcdefgh', 'AC2 the unsupported record names its source');

-- A claimed article job is fenced; the extraction stores the verbatim paragraphs once.
select is((select attempts from public.claim_article_extraction_job()), 1,
  'article work claims independently with a fencing attempt');
select is((select count(*) from public.claim_article_extraction_job()), 0::bigint,
  'a live article lease cannot be claimed by an overlapping worker');
create temporary table full_record as select jsonb_build_object(
  'captureId', '24242424-0000-4000-8000-000000000011', 'status', 'full', 'reason', null,
  'sourceUrl', 'https://example.com/essay', 'title', 'Essay', 'byline', 'Ada',
  'siteName', 'Example', 'language', 'en',
  'paragraphs', jsonb_build_array('First paragraph.', 'Second paragraph.'),
  'wordCount', 240, 'extractorVersion', 'article-extraction-v1'
) as record;
select throws_ok($$select * from public.finish_article_extraction_attempt(
    (select id from public.capture_jobs where source_analysis_id = '24242424-0000-4000-8000-000000000021'),
    1, jsonb_set((select record from full_record), '{status}', '"partial"'))$$,
  'P0001', 'invalid_article_extraction', 'partial text can never be stored with paragraphs');
select is((select count(*) from public.finish_article_extraction_attempt(
    (select id from public.capture_jobs where source_analysis_id = '24242424-0000-4000-8000-000000000021'),
    1, (select record from full_record))), 1::bigint, 'fenced completion publishes once');
select is((select paragraphs from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000021'),
  '["First paragraph.", "Second paragraph."]'::jsonb, 'the paragraphs are stored verbatim and in order');
select is((select content_sha256 from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000021'),
  encode(sha256(convert_to(E'First paragraph.\n\nSecond paragraph.', 'UTF8')), 'hex'),
  'the database computes the digest over exactly the stored paragraphs');
select is((select status from public.capture_jobs
  where source_analysis_id = '24242424-0000-4000-8000-000000000021'), 'completed',
  'successful extraction completes its durable job');
select * from public.finish_article_extraction_attempt(
  (select id from public.capture_jobs where source_analysis_id = '24242424-0000-4000-8000-000000000021'),
  1, (select record from full_record));
select is((select count(*) from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000021'), 1::bigint,
  'AC1 a replayed finish cannot append another extraction');

-- AC7: extractions are append-only.
select throws_ok($$update public.capture_article_extractions set title = 'Rewritten'
  where source_analysis_id = '24242424-0000-4000-8000-000000000021'$$,
  '55000', 'article extractions are immutable', 'AC7 an UPDATE on an extraction raises');

-- AC5 (database half): fetch failures retry with backoff and end failed/fetch_failed.
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, confidence, model_id,
   prompt_version, pipeline_version)
values ('24242424-0000-4000-8000-000000000025', '24242424-0000-4000-8000-000000000013',
  'source_resolution', 'succeeded', '{}',
  '{"status":"resolved","sourceType":"article","title":"Gone","creator":"Ada","canonicalUrl":"https://example.com/unreachable","durationSeconds":null,"transcriptUrl":null}',
  0.9, null, 'source-direct-v0.1', 'source-resolution-pipeline-v0.1');
create temporary table retry_job as select id from public.capture_jobs
  where source_analysis_id = '24242424-0000-4000-8000-000000000025';
select * from public.claim_article_extraction_job();
select * from public.finish_article_extraction_attempt((select id from retry_job), 1, null, 'fetch_failed');
select ok((select status = 'pending' and last_error = 'fetch_failed' and available_at > now()
  from public.capture_jobs where id = (select id from retry_job)),
  'AC5 a fetch failure retries later with backoff');
update public.capture_jobs set available_at = now() where id = (select id from retry_job);
select * from public.claim_article_extraction_job();
select * from public.finish_article_extraction_attempt((select id from retry_job), 2, null, 'unsafe_url');
update public.capture_jobs set available_at = now() where id = (select id from retry_job);
select * from public.claim_article_extraction_job();
select is((select count(*) from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000025'), 0::bigint,
  'AC5 no terminal record is written while retries remain');
select * from public.finish_article_extraction_attempt((select id from retry_job), 3, null, 'fetch_failed');
select is((select status from public.capture_jobs where id = (select id from retry_job)), 'failed',
  'AC5 the job is terminal after three attempts');
select ok((select status = 'failed' and reason = 'fetch_failed' and paragraphs is null
  and source_url = 'https://example.com/unreachable'
  from public.capture_article_extractions
  where source_analysis_id = '24242424-0000-4000-8000-000000000025'),
  'AC5 the terminal outcome is recorded failed/fetch_failed');

-- AC6: owners read an extraction only after committed exposure; other users never.
set local role authenticated;
select set_config('request.jwt.claim.sub', '24242424-0000-4000-8000-000000000001', true);
select is((select count(*) from public.capture_article_extractions
  where capture_id = '24242424-0000-4000-8000-000000000011'), 0::bigint,
  'AC6 an unexposed capture''s extraction is not readable by its owner');
select throws_ok($$update public.capture_article_extractions set title = 'x'$$, '42501', null,
  'AC6 authenticated users cannot write extractions');
select ok(public.revisit_expose('24242424-0000-4000-8000-000000000011'), 'the owner exposes the capture');
select is((select count(*) from public.capture_article_extractions
  where capture_id = '24242424-0000-4000-8000-000000000011'), 1::bigint,
  'AC6 after revisit_expose the owner reads the extraction');
select set_config('request.jwt.claim.sub', '24242424-0000-4000-8000-000000000002', true);
select is((select count(*) from public.capture_article_extractions), 0::bigint,
  'AC6 another user never sees the extraction');
reset role;

select * from finish();
rollback;

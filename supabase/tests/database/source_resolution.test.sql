begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

select has_function('public', 'claim_source_resolution_job', array[]::text[], 'source jobs have a dedicated claim RPC');
select has_function('public', 'finish_source_resolution_attempt', array['uuid','integer','jsonb','text'], 'source jobs have a fenced finalization RPC');
select ok(not has_function_privilege('anon', 'public.claim_source_resolution_job()', 'execute'), 'AC4 anonymous callers cannot claim source work');
select ok(not has_function_privilege('authenticated', 'public.finish_source_resolution_attempt(uuid,integer,jsonb,text)', 'execute'), 'AC4 users cannot publish source analyses');

insert into auth.users (id, email)
values ('10101010-1010-1010-1010-101010101010', 'source-owner@example.test');
insert into public.captures (id, user_id, capture_channel, capture_kind, raw_text, captured_at, raw_payload)
values ('10101010-1010-1010-1010-101010101011', '10101010-1010-1010-1010-101010101010',
  'whatsapp', 'link', 'https://www.youtube.com/watch?v=source12345', now(), '{}');
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, confidence, model_id, prompt_version, pipeline_version)
values ('10101010-1010-1010-1010-101010101012', '10101010-1010-1010-1010-101010101011',
  'intent', 'succeeded', '{"capture":"original"}', '{"resolutionRequired":true}', 0.7,
  'intent-model', 'intent-v1', 'intent-pipeline-v1');
insert into public.capture_jobs (id, capture_id, job_type)
values ('10101010-1010-1010-1010-101010101013', '10101010-1010-1010-1010-101010101011', 'source_resolution');

select is((select intent_analysis_id from public.capture_jobs where id='10101010-1010-1010-1010-101010101013'),
  '10101010-1010-1010-1010-101010101012'::uuid, 'AC2 source job binds the selected successful intent run atomically');
select is((select attempts from public.claim_source_resolution_job()), 1, 'AC1 source work claims independently with a fencing attempt');
select is((select count(*) from public.claim_source_resolution_job()), 0::bigint, 'AC5 a live source lease cannot be claimed twice');

create temporary table direct_record as select jsonb_build_object(
  'captureId','10101010-1010-1010-1010-101010101011', 'status','succeeded',
  'inputSnapshot', jsonb_build_object(
    'capture',jsonb_build_object('rawText','https://www.youtube.com/watch?v=source12345'),
    'intentAnalysis',jsonb_build_object('id','10101010-1010-1010-1010-101010101012'),
    'publicMetadata',jsonb_build_array(jsonb_build_object('title','The Source Episode')),
    'evidence',jsonb_build_array(
      jsonb_build_object('id','metadata.0.title'),
      jsonb_build_object('id','metadata.0.creator'),
      jsonb_build_object('id','metadata.0.canonicalUrl')
    )
  ),
  'result', jsonb_build_object(
    'status','resolved','sourceType','youtube_video','title','The Source Episode','creator','Ada Example',
    'canonicalUrl','https://www.youtube.com/watch?v=source12345','durationSeconds',1800,
    'transcriptUrl','https://www.youtube.com/transcript/source12345.vtt','confidence',0.9,
    'evidence',jsonb_build_array('metadata.0.title','metadata.0.creator','metadata.0.canonicalUrl')
  ),
  'confidence',0.9,'modelId',null,'promptVersion','source-direct-v0.1',
  'pipelineVersion','source-resolution-pipeline-v0.1','errorCode',null
) as record;

select is((select count(*) from public.finish_source_resolution_attempt(
  '10101010-1010-1010-1010-101010101013',1,(select record from direct_record))), 1::bigint,
  'AC1 fenced direct completion publishes once');
select is((select count(*) from public.capture_analyses where capture_id='10101010-1010-1010-1010-101010101011'
  and analysis_type='source_resolution'), 1::bigint, 'AC1 exactly one immutable source result is stored');
select is((select result->>'canonicalUrl' from public.capture_analyses where analysis_type='source_resolution'),
  'https://www.youtube.com/watch?v=source12345', 'AC1 canonical identity is retained');
select is((select confidence from public.capture_analyses where analysis_type='source_resolution'),
  0.9::numeric, 'AC1 source confidence is stored on its own analysis');
select ok((select prompt_version='source-direct-v0.1' and pipeline_version='source-resolution-pipeline-v0.1'
  from public.capture_analyses where analysis_type='source_resolution'), 'AC1 complete prompt and pipeline provenance is stored');
select is((select model_id from public.capture_analyses where analysis_type='source_resolution'), null,
  'AC1 deterministic resolution records that no model was used');
select is((select count(*) from public.capture_jobs where job_type='segment_resolution'), 1::bigint,
  'AC6 one transcript-backed segment job is enqueued');
select ok((select source_analysis_id=(select id from public.capture_analyses where analysis_type='source_resolution')
  from public.capture_jobs where job_type='segment_resolution'), 'AC6 segment work cites the exact source analysis');

select * from public.finish_source_resolution_attempt(
  '10101010-1010-1010-1010-101010101013',1,(select record from direct_record));
select is((select count(*) from public.capture_analyses where analysis_type='source_resolution'), 1::bigint,
  'AC5 replay cannot append another successful analysis');
select is((select count(*) from public.capture_jobs where job_type='segment_resolution'), 1::bigint,
  'AC6 replay cannot enqueue a second segment job');
select throws_ok($$update public.capture_analyses set confidence=0.1
  where analysis_type='source_resolution'$$, '55000', 'capture analyses are immutable',
  'AC1 successful source analyses cannot be overwritten');
select is((select raw_text from public.captures where id='10101010-1010-1010-1010-101010101011'),
  'https://www.youtube.com/watch?v=source12345', 'AC2 resolution leaves the original capture unchanged');
select is((select input_snapshot->>'capture' from public.capture_analyses where id='10101010-1010-1010-1010-101010101012'),
  'original', 'AC2 resolution leaves the selected intent analysis unchanged');

insert into public.capture_jobs (id,capture_id,job_type)
values ('10101010-1010-1010-1010-101010101014','10101010-1010-1010-1010-101010101011','source_resolution');
select * from public.claim_source_resolution_job();
create temporary table no_transcript_record as select jsonb_set(
  (select record from direct_record), '{result,transcriptUrl}', 'null'::jsonb
) as record;
select is((select count(segment_job_id) from public.finish_source_resolution_attempt(
  '10101010-1010-1010-1010-101010101014',1,(select record from no_transcript_record))), 0::bigint,
  'AC6 a resolved source without segmentable material returns no segment job');
select is((select count(*) from public.capture_jobs where job_type='segment_resolution'), 1::bigint,
  'AC6 no transcript means no new segment job exists');

insert into public.capture_jobs (id,capture_id,job_type)
values ('10101010-1010-1010-1010-101010101015','10101010-1010-1010-1010-101010101011','source_resolution');
select * from public.claim_source_resolution_job();
create temporary table unresolved_record as select jsonb_set(
  jsonb_set(
    (select record from direct_record), '{result}',
    '{"status":"unresolved","sourceType":null,"title":null,"creator":null,"canonicalUrl":null,"durationSeconds":null,"transcriptUrl":null,"confidence":0,"evidence":["resolution.notice.0"]}'::jsonb
  ),
  '{inputSnapshot,evidence}', '[{"id":"resolution.notice.0"}]'::jsonb
) #- '{modelId}' as record;
select * from public.finish_source_resolution_attempt(
  '10101010-1010-1010-1010-101010101015',1,(select record from unresolved_record));
select ok((select result->>'status'='unresolved' and result->'title'='null'::jsonb
  and result->'creator'='null'::jsonb and result->'canonicalUrl'='null'::jsonb
  from public.capture_analyses where analysis_type='source_resolution'
    and result->>'status'='unresolved' limit 1),
  'AC3 unresolved is a successful explicit result with no invented identity');
select is((select count(*) from public.capture_jobs where job_type='segment_resolution'), 1::bigint,
  'AC3 unresolved results never enqueue segment work');

insert into public.capture_jobs (id,capture_id,job_type)
values ('10101010-1010-1010-1010-101010101016','10101010-1010-1010-1010-101010101011','source_resolution');
select * from public.claim_source_resolution_job();
create temporary table failed_record as select jsonb_build_object(
  'captureId','10101010-1010-1010-1010-101010101011','status','failed',
  'inputSnapshot',jsonb_build_object('intentAnalysis',jsonb_build_object('id','10101010-1010-1010-1010-101010101012')),
  'result',null,'confidence',null,'modelId',null,'promptVersion','source-resolution-v0.1',
  'pipelineVersion','source-resolution-pipeline-v0.1','errorCode','provider_unavailable'
) as record;
select * from public.finish_source_resolution_attempt(
  '10101010-1010-1010-1010-101010101016',1,(select record from failed_record),'private upstream response');
select ok((select status='pending' and attempts=1 and last_error='provider_unavailable'
  from public.capture_jobs where id='10101010-1010-1010-1010-101010101016'),
  'AC5 transient failure follows shared retry delay with only a safe code');
select ok((select status='failed' and result is null and error_code='provider_unavailable'
  from public.capture_analyses where analysis_type='source_resolution' and status='failed' limit 1),
  'AC5 failed analysis records only safe detail');
select is((select count(*) from public.capture_analyses where analysis_type='source_resolution' and status='succeeded'),
  3::bigint, 'AC5 a failure does not overwrite any successful source analysis');

set local role authenticated;
select set_config('request.jwt.claim.sub','10101010-1010-1010-1010-101010101010',true);
select is((select jsonb_object_agg(analysis_type,n) from (
  select analysis_type,count(*) as n from public.research_analysis_outcomes group by analysis_type
) grouped), '{"intent": 1, "source_resolution": 4}'::jsonb,
  'AC7 research API returns intent and source outcomes as separate analysis types');
select ok((select bool_and((analysis_type='intent' and confidence=0.7)
  or (analysis_type='source_resolution' and (confidence in (0.9,0) or confidence is null)))
  from public.research_analysis_outcomes),
  'AC7 each research outcome retains the confidence of its own stage');

select * from finish();
rollback;

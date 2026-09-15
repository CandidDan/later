begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

select has_function('public', 'claim_segment_resolution_job', array[]::text[],
  'segment jobs have a dedicated claim RPC');
select has_function('public', 'finish_segment_resolution_attempt', array['uuid','integer','jsonb','text'],
  'segment jobs have a fenced finalization RPC');
select ok(not has_function_privilege('anon', 'public.claim_segment_resolution_job()', 'execute'),
  'AC5 anonymous callers cannot claim segment work');
select ok(not has_function_privilege('authenticated',
  'public.finish_segment_resolution_attempt(uuid,integer,jsonb,text)', 'execute'),
  'AC5 users cannot publish segment analyses');

insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111110', 'segment-owner@example.test');
insert into public.captures
  (id, user_id, capture_channel, capture_kind, raw_text, captured_at, raw_payload)
values ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111110',
  'whatsapp', 'link', 'A saved clip about durable queues', now(), '{}');
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, confidence,
   model_id, prompt_version, pipeline_version)
values
  ('11111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111',
   'intent', 'succeeded', '{"capture":"original"}',
   '{"interest":{"summary":"durable queues","confidence":0.8}}', 0.8,
   'intent-model', 'intent-v1', 'intent-pipeline-v1'),
  ('11111111-1111-1111-1111-111111111113', '11111111-1111-1111-1111-111111111111',
   'source_resolution', 'succeeded',
   '{"intentAnalysis":{"id":"11111111-1111-1111-1111-111111111112"}}',
   '{"status":"resolved","durationSeconds":120,"transcriptUrl":"https://example.com/transcript.vtt"}',
   0.9, null, 'source-direct-v0.1', 'source-resolution-pipeline-v0.1');
insert into public.capture_jobs (id, capture_id, job_type, source_analysis_id)
values ('11111111-1111-1111-1111-111111111114', '11111111-1111-1111-1111-111111111111',
  'segment_resolution', '11111111-1111-1111-1111-111111111113');

select is((select attempts from public.claim_segment_resolution_job()), 1,
  'AC1 segment work claims independently with a fencing attempt');
select is((select count(*) from public.claim_segment_resolution_job()), 0::bigint,
  'AC6 a live segment lease cannot be claimed by an overlapping worker');

create temporary table timed_segment_record as select jsonb_build_object(
  'captureId','11111111-1111-1111-1111-111111111111', 'status','succeeded',
  'inputSnapshot',jsonb_build_object(
    'segmentJob',jsonb_build_object('id','11111111-1111-1111-1111-111111111114','attempt',1),
    'sourceAnalysis',jsonb_build_object('id','11111111-1111-1111-1111-111111111113'),
    'frozenInterest',jsonb_build_object('summary','durable queues'),
    'sourceMaterial',jsonb_build_object('finalUrl','https://cdn.example.com/transcript.vtt',
      'sha256',repeat('a',64),'contentType','text/vtt','representation','timed','durationSeconds',120),
    'evidence',jsonb_build_array(jsonb_build_object('id','cue.1','kind','timed',
      'startSeconds',14,'endSeconds',22,'text','Durable queues survive retries'))
  ),
  'result',jsonb_build_object(
    'status','resolved','representation','timed','startSeconds',14,'endSeconds',22,
    'sectionStart',null,'sectionEnd',null,'excerpt','Durable queues survive retries','label',null,
    'confidence',0.92,'evidence',jsonb_build_array('cue.1')
  ),
  'confidence',0.92,'modelId','claude-segment-reported','promptVersion','segment-resolution-v0.1',
  'pipelineVersion','segment-resolution-pipeline-v0.1','errorCode',null
) as record;

select is((select count(*) from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111114',1,(select record from timed_segment_record))), 1::bigint,
  'AC1 fenced completion publishes once');
select is((select count(*) from public.capture_analyses where analysis_type='segment_resolution'), 1::bigint,
  'AC1 exactly one immutable segment result is stored');
select ok((select (result->>'startSeconds')::numeric=14 and (result->>'endSeconds')::numeric=22
  from public.capture_analyses where analysis_type='segment_resolution'),
  'AC1 ordered in-range timestamps are stored');
select is((select result->>'excerpt' from public.capture_analyses where analysis_type='segment_resolution'),
  'Durable queues survive retries', 'AC1 the identifying excerpt is retained');
select is((select confidence from public.capture_analyses where analysis_type='segment_resolution'),
  0.92::numeric, 'AC1 segment confidence is stored independently');
select is((select input_snapshot->'sourceAnalysis'->>'id' from public.capture_analyses
  where analysis_type='segment_resolution'), '11111111-1111-1111-1111-111111111113',
  'AC1 the exact source analysis id is retained');
select is((select input_snapshot->'sourceMaterial'->>'sha256' from public.capture_analyses
  where analysis_type='segment_resolution'), repeat('a',64),
  'AC1 the transcript digest is retained');
select ok((select model_id='claude-segment-reported' and prompt_version='segment-resolution-v0.1'
  and pipeline_version='segment-resolution-pipeline-v0.1' from public.capture_analyses
  where analysis_type='segment_resolution'), 'AC1 model, prompt and pipeline provenance are complete');
select is((select status from public.capture_jobs where id='11111111-1111-1111-1111-111111111114'),
  'completed', 'AC1 successful segment work completes its durable job');

select * from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111114',1,(select record from timed_segment_record));
select is((select count(*) from public.capture_analyses where analysis_type='segment_resolution'), 1::bigint,
  'AC6 replay cannot append another successful analysis for the same job');
select throws_ok($$update public.capture_analyses set confidence=0.1
  where analysis_type='segment_resolution'$$, '55000', 'capture analyses are immutable',
  'AC6 successful segment analyses cannot be overwritten');
select is((select result->>'status' from public.capture_analyses
  where id='11111111-1111-1111-1111-111111111113'), 'resolved',
  'AC6 segment processing leaves the source analysis unchanged');
select is((select input_snapshot->>'capture' from public.capture_analyses
  where id='11111111-1111-1111-1111-111111111112'), 'original',
  'AC6 segment processing leaves the intent analysis unchanged');

-- A distinct source analysis gives the validation/retry path its own unique segment job.
insert into public.capture_analyses
  (id,capture_id,analysis_type,status,input_snapshot,result,confidence,model_id,prompt_version,pipeline_version)
values ('11111111-1111-1111-1111-111111111115','11111111-1111-1111-1111-111111111111',
  'source_resolution','succeeded','{}','{"status":"resolved","transcriptUrl":"https://example.com/bad.vtt"}',
  0.7,null,'source-direct-v0.1','source-resolution-pipeline-v0.1');
insert into public.capture_jobs (id,capture_id,job_type,source_analysis_id)
values ('11111111-1111-1111-1111-111111111116','11111111-1111-1111-1111-111111111111',
  'segment_resolution','11111111-1111-1111-1111-111111111115');
select * from public.claim_segment_resolution_job();
create temporary table invalid_segment_record as select jsonb_set(
  jsonb_set((select record from timed_segment_record),'{inputSnapshot,segmentJob,id}',
    '"11111111-1111-1111-1111-111111111116"'::jsonb),
  '{inputSnapshot,sourceAnalysis,id}','"11111111-1111-1111-1111-111111111115"'::jsonb
) as record;
select throws_ok($$select * from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111116',1,
  jsonb_set((select record from invalid_segment_record),'{result,endSeconds}','-1'::jsonb))$$,
  'P0001', 'invalid_segment_result', 'AC4 invalid timestamps cannot publish a successful result');
create temporary table failed_segment_record as select jsonb_set(
  jsonb_set(jsonb_set((select record from invalid_segment_record),'{status}','"failed"'::jsonb),
    '{result}','null'::jsonb),'{confidence}','null'::jsonb
) as record;
select * from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111116',1,(select record from failed_segment_record),
  'private provider response');
select ok((select status='pending' and attempts=1 and last_error='provider_unavailable'
  from public.capture_jobs where id='11111111-1111-1111-1111-111111111116'),
  'AC4 invalid/model failure follows the safe retry policy');
select ok((select status='failed' and result is null and error_code='provider_unavailable'
  from public.capture_analyses where analysis_type='segment_resolution' and status='failed'),
  'AC4 failed segment analysis stores only a safe error code');
select is((select count(*) from public.capture_analyses where analysis_type='segment_resolution'
  and status='succeeded'), 1::bigint, 'AC4 failure does not overwrite the successful segment result');

-- Unsupported/absent material is an explicit successful unresolved experiment outcome.
insert into public.capture_analyses
  (id,capture_id,analysis_type,status,input_snapshot,result,confidence,model_id,prompt_version,pipeline_version)
values ('11111111-1111-1111-1111-111111111117','11111111-1111-1111-1111-111111111111',
  'source_resolution','succeeded','{}','{"status":"resolved","transcriptUrl":null}',0.5,null,
  'source-direct-v0.1','source-resolution-pipeline-v0.1');
insert into public.capture_jobs (id,capture_id,job_type,source_analysis_id)
values ('11111111-1111-1111-1111-111111111118','11111111-1111-1111-1111-111111111111',
  'segment_resolution','11111111-1111-1111-1111-111111111117');
select * from public.claim_segment_resolution_job();
create temporary table unresolved_segment_record as select jsonb_build_object(
  'captureId','11111111-1111-1111-1111-111111111111','status','succeeded',
  'inputSnapshot',jsonb_build_object(
    'segmentJob',jsonb_build_object('id','11111111-1111-1111-1111-111111111118','attempt',1),
    'sourceAnalysis',jsonb_build_object('id','11111111-1111-1111-1111-111111111117'),
    'sourceMaterial',null,'evidence',jsonb_build_array(jsonb_build_object('id','segment.notice.0'))),
  'result',jsonb_build_object('status','unresolved','representation',null,'startSeconds',null,
    'endSeconds',null,'sectionStart',null,'sectionEnd',null,'excerpt',null,'label',null,
    'confidence',0,'evidence',jsonb_build_array('segment.notice.0')),
  'confidence',0,'modelId',null,'promptVersion','segment-unavailable-v0.1',
  'pipelineVersion','segment-resolution-pipeline-v0.1','errorCode',null
) as record;
select is((select count(*) from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111118',1,(select record from unresolved_segment_record))),1::bigint,
  'AC3 unavailable material completes with an explicit analysis');
select ok((select result->>'status'='unresolved' and result->'startSeconds'='null'::jsonb
  and result->'excerpt'='null'::jsonb and model_id is null from public.capture_analyses
  where analysis_type='segment_resolution' and result->>'status'='unresolved'),
  'AC3 unresolved material invents no timestamp, excerpt or model provenance');

-- Text outcomes retain text boundaries/excerpts and cannot masquerade as timed results.
insert into public.capture_analyses
  (id,capture_id,analysis_type,status,input_snapshot,result,confidence,model_id,prompt_version,pipeline_version)
values ('11111111-1111-1111-1111-111111111119','11111111-1111-1111-1111-111111111111',
  'source_resolution','succeeded','{}','{"status":"resolved","transcriptUrl":"https://example.com/article.txt"}',
  0.6,null,'source-direct-v0.1','source-resolution-pipeline-v0.1');
insert into public.capture_jobs (id,capture_id,job_type,source_analysis_id)
values ('11111111-1111-1111-1111-111111111120','11111111-1111-1111-1111-111111111111',
  'segment_resolution','11111111-1111-1111-1111-111111111119');
select * from public.claim_segment_resolution_job();
create temporary table text_segment_record as select jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  jsonb_set((select record from timed_segment_record),'{inputSnapshot,segmentJob,id}',
    '"11111111-1111-1111-1111-111111111120"'::jsonb),
  '{inputSnapshot,sourceAnalysis,id}','"11111111-1111-1111-1111-111111111119"'::jsonb),
  '{result,representation}','"text"'::jsonb),'{result,startSeconds}','null'::jsonb),
  '{result,endSeconds}','null'::jsonb),'{result,sectionStart}','8'::jsonb
) as record;
update text_segment_record set record = jsonb_set(record,'{result,sectionEnd}','39'::jsonb);
select * from public.finish_segment_resolution_attempt(
  '11111111-1111-1111-1111-111111111120',1,(select record from text_segment_record));
select ok((select result->>'representation'='text' and result->'startSeconds'='null'::jsonb
  and result->>'excerpt'='Durable queues survive retries' from public.capture_analyses
  where analysis_type='segment_resolution' and result->>'representation'='text'),
  'AC2 text outcomes retain an excerpt/boundary without fabricated audio timestamps');

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111110',true);
select is((select jsonb_object_agg(analysis_type,n) from (
  select analysis_type,count(*) as n from public.research_analysis_outcomes group by analysis_type
) grouped), '{"intent": 1, "source_resolution": 4, "segment_resolution": 4}'::jsonb,
  'AC7 research returns intent, source and segment as three independent stages');
select ok((select bool_and(
  (analysis_type='intent' and confidence=0.8)
  or (analysis_type='source_resolution' and confidence in (0.9,0.7,0.5,0.6))
  or (analysis_type='segment_resolution' and (confidence in (0.92,0) or confidence is null))
) from public.research_analysis_outcomes),
  'AC7 every research stage retains its own status/confidence');

select * from finish();
rollback;

begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

select is((select schedule from cron.job where jobname = 'later-intent-processing'), '* * * * *', 'AC1 schedule fires once per minute');
select is((select command from cron.job where jobname = 'later-intent-processing'), 'select public.dispatch_intent_processing();', 'AC2 persisted scheduler text contains only a function call');
select ok(not has_function_privilege('anon', 'public.dispatch_intent_processing()', 'execute'), 'AC2 anonymous users cannot dispatch');
select ok(not has_function_privilege('authenticated', 'public.claim_intent_job(text)', 'execute'), 'AC2 users cannot claim');
select ok(not has_function_privilege('authenticated', 'public.finish_intent_attempt(uuid,integer,jsonb,text)', 'execute'), 'AC2 users cannot finalize');

-- These clearly synthetic values never leave this rolled-back transaction.
delete from vault.secrets where name in ('later_jobs_process_url', 'later_jobs_process_secret');
create temporary table queue_before as select count(*) as n from net.http_request_queue;
select public.dispatch_intent_processing();
select is((select count(*) from net.http_request_queue), (select n from queue_before), 'AC2 no dispatch without Vault entries');
do $$ begin perform vault.create_secret('https://intent-test.invalid/api/jobs/process', 'later_jobs_process_url'); end $$;
select public.dispatch_intent_processing();
select is((select count(*) from net.http_request_queue), (select n from queue_before), 'AC2 missing bearer prevents dispatch');
delete from vault.secrets where name = 'later_jobs_process_url';
do $$ begin perform vault.create_secret('TEST-ONLY-NOT-A-CREDENTIAL', 'later_jobs_process_secret'); end $$;
select public.dispatch_intent_processing();
select is((select count(*) from net.http_request_queue), (select n from queue_before), 'AC2 missing URL prevents dispatch');
do $$ begin perform vault.create_secret('https://intent-test.invalid/api/jobs/process', 'later_jobs_process_url'); end $$;
do $$ declare command text; begin select j.command into command from cron.job j where jobname = 'later-intent-processing'; execute command; end $$;
select is((select count(*) from net.http_request_queue), (select n + 1 from queue_before), 'AC1 firing stored cron command enqueues a request');
select ok(exists(select 1 from net.http_request_queue where url = 'https://intent-test.invalid/api/jobs/process' and method = 'POST' and headers->>'Authorization' = 'Bearer TEST-ONLY-NOT-A-CREDENTIAL'), 'AC1 request uses configured endpoint and bearer');
select ok(not exists(select 1 from cron.job where command like '%TEST-ONLY%' or command like '%intent-test.invalid%'), 'AC2 neither Vault value persists in scheduler command');

insert into auth.users (id) values ('00000000-0000-0000-0000-000000000006');
insert into public.captures (id,user_id,capture_channel,captured_at)
values ('00000000-0000-0000-0000-000000000060','00000000-0000-0000-0000-000000000006','test',now());
-- Keep this test deterministic if other fixtures exist.
update public.capture_jobs set available_at = now() + interval '1 day' where status = 'pending';
insert into public.capture_jobs (id,capture_id,job_type)
values ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000060','intent_analysis');
select is((select attempts from public.claim_intent_job('intent_analysis')), 1, 'AC3 first claim consumes one attempt');
select is((select count(*) from public.claim_intent_job('intent_analysis')), 0::bigint, 'AC5 overlapping call cannot own a live lease');
select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',1,null,'untrusted private provider text');
select ok((select status = 'pending' and available_at = now() + interval '1 minute' and last_error = 'provider_unavailable' from public.capture_jobs where id = '00000000-0000-0000-0000-000000000061'), 'AC3 first failure is delayed and sanitized');
select is((select count(*) from public.claim_intent_job('intent_analysis')), 0::bigint, 'AC3 same drain cannot reclaim before available_at');
update public.capture_jobs set available_at = now() where id = '00000000-0000-0000-0000-000000000061';
select is((select attempts from public.claim_intent_job('intent_analysis')), 2, 'AC3 second attempt becomes available');
select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',2,null,'provider_unavailable');
select ok((select available_at = now() + interval '2 minutes' from public.capture_jobs where id = '00000000-0000-0000-0000-000000000061'), 'AC3 second delay increases');
update public.capture_jobs set available_at = now() where id = '00000000-0000-0000-0000-000000000061';
select is((select attempts from public.claim_intent_job('intent_analysis')), 3, 'AC3 third attempt is last');
select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',3,null,'provider_unavailable');
select is((select status from public.capture_jobs where id = '00000000-0000-0000-0000-000000000061'), 'failed', 'AC3 third failure is terminal');
select is((select count(*) from public.claim_intent_job('intent_analysis')), 0::bigint, 'AC3 terminal failure is never reclaimed');

update public.capture_jobs set status='processing', attempts=1, locked_at=now()-interval '11 minutes' where id='00000000-0000-0000-0000-000000000061';
select is((select attempts from public.claim_intent_job('intent_analysis')), 2, 'AC4 stale lease is recovered as a new attempt');
select is((select count(*) from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',1,null,'provider_unavailable')),0::bigint,'AC5 stale worker cannot release the new owner');
select is((select count(*) from public.claim_intent_job('intent_analysis')),0::bigint,'AC4 recovered live lease remains unavailable');
create temporary table success_record as select jsonb_build_object('captureId','00000000-0000-0000-0000-000000000060','status','succeeded','inputSnapshot','{}'::jsonb,'result','{"resolutionRequired":true}'::jsonb,'confidence',0.8,'modelId','test-model','promptVersion','test','pipelineVersion','test') as record;
select is((select count(*) from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',1,(select record from success_record))),0::bigint,'AC5 late stale success cannot append');
-- A failing insert within completion must roll back the whole transaction.
create function pg_temp.reject_completion() returns trigger language plpgsql as $$ begin if new.status = 'completed' then raise exception 'test interruption'; end if; return new; end $$;
create trigger test_interruption before update on public.capture_jobs for each row execute function pg_temp.reject_completion();
select throws_ok($$select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',2,(select record from success_record))$$, 'P0001','test interruption','AC5 interrupted completion fails atomically');
select is((select count(*) from public.capture_analyses where capture_id='00000000-0000-0000-0000-000000000060'),0::bigint,'AC5 interruption leaves no partial successful analysis');
drop trigger test_interruption on public.capture_jobs;
select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',2,(select record from success_record));
select * from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',2,(select record from success_record));
select ok((select status='completed' and completed_at is not null from public.capture_jobs where id='00000000-0000-0000-0000-000000000061') and (select count(*)=1 from public.capture_analyses where capture_id='00000000-0000-0000-0000-000000000060'), 'AC1/AC5 processing completes with exactly one success despite replay');
select is((select count(*) from public.capture_jobs where capture_id='00000000-0000-0000-0000-000000000060' and job_type='source_resolution'),1::bigint,'AC5 atomic completion enqueues resolution once');
select is((select count(*) from public.claim_intent_job('source_resolution')),0::bigint,'source-resolution jobs are never processed');
update public.capture_jobs set status='processing', attempts=3, locked_at=now()-interval '11 minutes' where id='00000000-0000-0000-0000-000000000061';
select * from public.claim_intent_job('intent_analysis');
select is((select status from public.capture_jobs where id='00000000-0000-0000-0000-000000000061'),'failed','AC4 interrupted third attempt becomes terminal');
update public.capture_jobs set status='pending', attempts=3 where id='00000000-0000-0000-0000-000000000061';
select * from public.claim_intent_job('intent_analysis');
select is((select status from public.capture_jobs where id='00000000-0000-0000-0000-000000000061'),'failed','AC3 legacy exhausted pending jobs do not remain stranded');
update public.capture_jobs set status='processing', attempts=1, locked_at=now()-interval '9 minutes' where id='00000000-0000-0000-0000-000000000061';
select is((select count(*) from public.claim_intent_job('intent_analysis')),0::bigint,'AC4 a nine-minute lease remains unavailable');
update public.capture_jobs set locked_at=now()-interval '11 minutes' where id='00000000-0000-0000-0000-000000000061';
select is((select count(*) from public.finish_intent_attempt('00000000-0000-0000-0000-000000000061',1,(select record from success_record))),0::bigint,'AC5 expired lease cannot publish even before recovery');
select is((select count(*) from public.capture_analyses where capture_id='00000000-0000-0000-0000-000000000060'),1::bigint,'AC5 expired completion leaves existing analyses unchanged');
select * from finish();
rollback;

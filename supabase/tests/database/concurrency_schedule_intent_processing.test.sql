-- Two independent database sessions race for a committed fixture. Clean up afterwards.
create extension if not exists dblink with schema extensions;
select plan(7);
-- Run with the isolated local test administrator (dblink requires a superuser for trust auth).
delete from auth.users where id='00000000-0000-0000-0000-000000000016';
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000016');
insert into public.captures(id,user_id,capture_channel,captured_at)
values ('00000000-0000-0000-0000-000000000160','00000000-0000-0000-0000-000000000016','concurrency-test',now());
insert into public.capture_jobs(id,capture_id,job_type,available_at)
values ('00000000-0000-0000-0000-000000000161','00000000-0000-0000-0000-000000000160','intent_analysis','2000-01-01');
select extensions.dblink_connect('worker_a','dbname=postgres user=postgres');
select extensions.dblink_exec('worker_a','begin');
select is((select attempts from extensions.dblink('worker_a',$$select attempts from public.claim_intent_job('intent_analysis')$$) as claim(attempts integer)),1,'AC5 first independent worker owns claim');
select is((select count(*) from public.claim_intent_job('intent_analysis')),0::bigint,'AC5 second connection skips the row locked by the first worker');
select extensions.dblink_exec('worker_a','commit');
select is((select count(*) from public.claim_intent_job('intent_analysis')),0::bigint,'AC5 committed live lease remains exclusive');
-- Worker A finalizes but holds its transaction open; worker B attempts the same completion.
select extensions.dblink_exec('worker_a','begin');
select * from extensions.dblink('worker_a',$$select analysis_id from public.finish_intent_attempt('00000000-0000-0000-0000-000000000161',1,'{"captureId":"00000000-0000-0000-0000-000000000160","status":"succeeded","inputSnapshot":{},"result":{},"modelId":"test-model","promptVersion":"test","pipelineVersion":"test"}')$$) as completed(analysis_id uuid);
select extensions.dblink_connect('worker_b','dbname=postgres user=postgres application_name=later_0006_worker_b');
select extensions.dblink_send_query('worker_b',$$select count(*) from public.finish_intent_attempt('00000000-0000-0000-0000-000000000161',1,'{"captureId":"00000000-0000-0000-0000-000000000160","status":"succeeded","inputSnapshot":{},"result":{},"modelId":"test-model","promptVersion":"test","pipelineVersion":"test"}')$$);
do $$ begin
  for i in 1..200 loop
    perform pg_stat_clear_snapshot();
    exit when exists(select 1 from pg_stat_activity where application_name='later_0006_worker_b' and wait_event_type='Lock');
    perform pg_sleep(0.01);
  end loop;
end $$;
select ok(exists(select 1 from pg_stat_activity where application_name='later_0006_worker_b' and wait_event_type='Lock'),'AC5 second finalizer waits on the first transaction before it commits');
select extensions.dblink_exec('worker_a','commit');
select is((select n from extensions.dblink_get_result('worker_b') as result(n bigint)),0::bigint,'AC5 concurrent finalizer loses ownership after first commit');
select is((select count(*) from public.capture_analyses where capture_id='00000000-0000-0000-0000-000000000160'),1::bigint,'AC5 exactly one success survives concurrent finalizers');
select is((select status from public.capture_jobs where id='00000000-0000-0000-0000-000000000161'),'completed','AC5 concurrent completion leaves a completed job');
select extensions.dblink_disconnect('worker_a');
select extensions.dblink_disconnect('worker_b');
delete from auth.users where id='00000000-0000-0000-0000-000000000016';
select * from finish();

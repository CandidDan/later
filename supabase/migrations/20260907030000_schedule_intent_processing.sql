-- Credentials are resolved only at dispatch time; cron stores only the function call.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function public.dispatch_intent_processing()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  bearer text;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets
    where name = 'later_jobs_process_url';
  select decrypted_secret into bearer from vault.decrypted_secrets
    where name = 'later_jobs_process_secret';
  if endpoint is null or bearer is null or btrim(bearer) = ''
     or endpoint !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/api/jobs/process$' then
    return;
  end if;
  perform net.http_post(
    url := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || bearer),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
exception when others then
  -- Neither a URL nor an exception containing credentials belongs in cron output.
  return;
end;
$$;
revoke all on function public.dispatch_intent_processing() from public, anon, authenticated, service_role;

select cron.schedule('later-intent-processing', '* * * * *',
  'select public.dispatch_intent_processing();');

create or replace function public.claim_intent_job(p_job_type text)
returns setof public.capture_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- This endpoint must never consume future source-resolution work.
  if p_job_type <> 'intent_analysis' or p_job_type is null then return; end if;

  -- Each lease consumes an attempt, including a worker that never returns.
  update public.capture_jobs
    set status = 'failed', locked_at = null,
      last_error = case when status = 'pending' then 'attempts_exhausted' else 'lease_expired' end, updated_at = now()
    where job_type = 'intent_analysis' and attempts >= 3
      and (status = 'pending' or (status = 'processing'
        and (locked_at is null or locked_at < now() - interval '10 minutes')));

  return query
    with candidate as (
      select j.id from public.capture_jobs j
      where j.job_type = 'intent_analysis' and j.attempts < 3
        and ((j.status = 'pending' and j.available_at <= now())
          or (j.status = 'processing' and (j.locked_at is null or j.locked_at < now() - interval '10 minutes')))
      order by j.available_at, j.created_at, j.id
      for update skip locked limit 1
    )
    update public.capture_jobs j
    set status = 'processing', attempts = j.attempts + 1, locked_at = now(), updated_at = now()
    from candidate c where j.id = c.id returning j.*;
end;
$$;

create or replace function public.finish_intent_attempt(
  p_job_id uuid, p_attempt integer, p_record jsonb, p_error_code text default null
)
returns table (analysis_id uuid, resolution_job_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.capture_jobs;
  safe_error text;
begin
  select * into job from public.capture_jobs where id = p_job_id for update;
  if not found or job.job_type <> 'intent_analysis' or job.status <> 'processing'
     or job.attempts <> p_attempt or p_attempt is null
     or job.locked_at is null or job.locked_at < now() - interval '10 minutes' then
    return;
  end if;

  safe_error := case when p_error_code in ('capture_missing', 'result_schema_invalid',
    'provider_response_invalid', 'provider_unavailable') then p_error_code
    when p_error_code is not null then 'provider_unavailable' else null end;
  if p_record is null and safe_error is null then
    raise exception 'invalid_attempt_record';
  end if;
  if p_record is not null then
    if p_record->>'captureId' is distinct from job.capture_id::text
       or p_record->>'status' is distinct from (case when safe_error is null then 'succeeded' else 'failed' end) then
      raise exception 'invalid_attempt_record';
    end if;
    insert into public.capture_analyses (
      capture_id, analysis_type, status, input_snapshot, result, confidence,
      model_id, prompt_version, pipeline_version, error_code
    ) values (
      job.capture_id, 'intent', p_record->>'status', p_record->'inputSnapshot',
      case when safe_error is null then p_record->'result' else null end,
      (p_record->>'confidence')::numeric, p_record->>'modelId',
      p_record->>'promptVersion', p_record->>'pipelineVersion', safe_error
    ) returning id into analysis_id;
  end if;

  if safe_error is null then
    if p_record->'result'->>'resolutionRequired' = 'true' then
      -- Serialize resolution enqueue across separate intent jobs for the same capture.
      perform 1 from public.captures where id = job.capture_id for update;
      if not exists (select 1 from public.capture_jobs
        where capture_id = job.capture_id and job_type = 'source_resolution' and status = 'pending') then
        insert into public.capture_jobs (capture_id, job_type)
          values (job.capture_id, 'source_resolution') returning id into resolution_job_id;
      end if;
    end if;
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = job.id;
  else
    update public.capture_jobs set status = case when attempts >= 3 then 'failed' else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null,
      last_error = safe_error, updated_at = now() where id = job.id;
  end if;
  return next;
end;
$$;

revoke all on function public.claim_intent_job(text) from public, anon, authenticated;
revoke all on function public.finish_intent_attempt(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_intent_job(text) to service_role;
grant execute on function public.finish_intent_attempt(uuid, integer, jsonb, text) to service_role;

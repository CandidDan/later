-- Resolve a source against one selected immutable intent run. Resolution outcomes remain a
-- distinct analysis type, and downstream segment work is tied to the exact source analysis.
alter table public.capture_analyses
  drop constraint capture_analyses_analysis_type_check,
  drop constraint capture_analyses_check;
alter table public.capture_analyses
  add constraint capture_analyses_analysis_type_check
    check (analysis_type in ('intent', 'source_resolution')),
  add constraint capture_analyses_record_shape check (
    (status = 'succeeded' and result is not null and error_code is null
      and (analysis_type <> 'intent' or model_id is not null))
    or (status = 'failed' and result is null and error_code is not null)
  );

-- Analyses are append-only. Deletion is intentionally still allowed through capture deletion.
create function public.prevent_capture_analysis_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'capture analyses are immutable' using errcode = '55000';
end;
$$;
create trigger prevent_capture_analysis_update
  before update on public.capture_analyses
  for each row execute function public.prevent_capture_analysis_update();

alter table public.capture_jobs drop constraint capture_jobs_job_type_check;
alter table public.capture_jobs
  add constraint capture_jobs_job_type_check check (
    job_type in ('intent_analysis', 'source_resolution', 'segment_resolution', 'media_download', 'email_enrichment')
  ),
  add column intent_analysis_id uuid references public.capture_analyses(id) on delete cascade,
  add column source_analysis_id uuid references public.capture_analyses(id) on delete cascade;

create unique index one_segment_resolution_per_source_analysis
  on public.capture_jobs(source_analysis_id)
  where job_type = 'segment_resolution';

-- Existing queued source work predates the explicit linkage. Bind it once to the newest
-- successful intent run; future jobs are bound atomically by the insert trigger below.
update public.capture_jobs j set intent_analysis_id = (
  select a.id from public.capture_analyses a
  where a.capture_id = j.capture_id and a.analysis_type = 'intent' and a.status = 'succeeded'
  order by a.created_at desc, a.id desc limit 1
) where j.job_type = 'source_resolution' and j.intent_analysis_id is null;

create function public.bind_source_resolution_intent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_type = 'source_resolution' and new.intent_analysis_id is null then
    select a.id into new.intent_analysis_id from public.capture_analyses a
      where a.capture_id = new.capture_id and a.analysis_type = 'intent' and a.status = 'succeeded'
      order by a.created_at desc, a.id desc limit 1;
  end if;
  return new;
end;
$$;
create trigger bind_source_resolution_intent
  before insert on public.capture_jobs
  for each row execute function public.bind_source_resolution_intent();

create function public.claim_source_resolution_job()
returns setof public.capture_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.capture_jobs set status = 'failed', locked_at = null,
    last_error = case when status = 'pending' then 'attempts_exhausted' else 'lease_expired' end,
    updated_at = now()
    where job_type = 'source_resolution' and attempts >= 3
      and (status = 'pending' or (status = 'processing'
        and (locked_at is null or locked_at < now() - interval '10 minutes')));

  return query with candidate as (
    select id from public.capture_jobs
    where job_type = 'source_resolution' and intent_analysis_id is not null and attempts < 3
      and ((status = 'pending' and available_at <= now())
        or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')))
    order by available_at, created_at, id for update skip locked limit 1
  ) update public.capture_jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now()
    from candidate c where j.id = c.id returning j.*;
end;
$$;

create function public.finish_source_resolution_attempt(
  p_job_id uuid, p_attempt integer, p_record jsonb, p_error_code text default null
)
returns table (analysis_id uuid, segment_job_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.capture_jobs;
  safe_error text;
  result_status text;
  transcript_url text;
begin
  select * into job from public.capture_jobs where id = p_job_id for update;
  if not found or job.job_type <> 'source_resolution' or job.status <> 'processing'
     or job.attempts <> p_attempt or p_attempt is null
     or job.locked_at is null or job.locked_at < now() - interval '10 minutes' then
    return;
  end if;

  safe_error := case when p_error_code in (
    'capture_missing', 'intent_missing', 'result_schema_invalid',
    'provider_response_invalid', 'provider_unavailable', 'metadata_unavailable'
  ) then p_error_code
  when p_error_code is not null then 'provider_unavailable' else null end;
  if p_record is null and safe_error is null then raise exception 'invalid_attempt_record'; end if;
  if p_record is not null then
    if p_record->>'captureId' is distinct from job.capture_id::text
       or p_record->>'status' is distinct from (case when safe_error is null then 'succeeded' else 'failed' end)
       or p_record->'inputSnapshot'->'intentAnalysis'->>'id' is distinct from job.intent_analysis_id::text then
      raise exception 'invalid_attempt_record';
    end if;
    if safe_error is null then
      result_status := p_record->'result'->>'status';
      if result_status not in ('resolved', 'unresolved')
         or jsonb_typeof(p_record->'result'->'evidence') <> 'array'
         or jsonb_array_length(p_record->'result'->'evidence') = 0
         or exists (
           select 1 from jsonb_array_elements_text(p_record->'result'->'evidence') selected(id)
           where not exists (
             select 1 from jsonb_array_elements(p_record->'inputSnapshot'->'evidence') item
             where item->>'id' = selected.id
           )
         )
         or (result_status = 'unresolved' and (
           p_record->'result'->'sourceType' is distinct from 'null'::jsonb
           or p_record->'result'->'title' is distinct from 'null'::jsonb
           or p_record->'result'->'creator' is distinct from 'null'::jsonb
           or p_record->'result'->'canonicalUrl' is distinct from 'null'::jsonb
           or p_record->'result'->'durationSeconds' is distinct from 'null'::jsonb
           or p_record->'result'->'transcriptUrl' is distinct from 'null'::jsonb
         )) then raise exception 'invalid_source_result'; end if;
    end if;
    insert into public.capture_analyses (
      capture_id, analysis_type, status, input_snapshot, result, confidence,
      model_id, prompt_version, pipeline_version, error_code
    ) values (
      job.capture_id, 'source_resolution', p_record->>'status', p_record->'inputSnapshot',
      case when safe_error is null then p_record->'result' else null end,
      case when safe_error is null then (p_record->>'confidence')::numeric else null end,
      p_record->>'modelId', p_record->>'promptVersion', p_record->>'pipelineVersion', safe_error
    ) returning id into analysis_id;
  end if;

  if safe_error is null then
    transcript_url := nullif(btrim(p_record->'result'->>'transcriptUrl'), '');
    if result_status = 'resolved' and transcript_url is not null then
      insert into public.capture_jobs(capture_id, job_type, source_analysis_id)
        values (job.capture_id, 'segment_resolution', analysis_id)
        on conflict do nothing returning id into segment_job_id;
    end if;
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = job.id;
  else
    update public.capture_jobs set status = case
        when safe_error in ('capture_missing', 'intent_missing') or attempts >= 3 then 'failed'
        else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null,
      last_error = safe_error, updated_at = now() where id = job.id;
  end if;
  return next;
end;
$$;

-- PostgREST exposes this security-invoker view for research queries. The stage identity and
-- confidence travel together, so an intent success cannot be counted as source success.
create view public.research_analysis_outcomes with (security_invoker = true) as
select id as analysis_id, capture_id, analysis_type, status, confidence, result,
  model_id, prompt_version, pipeline_version, created_at
from public.capture_analyses;
grant select on public.research_analysis_outcomes to authenticated;

revoke all on function public.prevent_capture_analysis_update() from public, anon, authenticated;
revoke all on function public.bind_source_resolution_intent() from public, anon, authenticated;
revoke all on function public.claim_source_resolution_job() from public, anon, authenticated;
revoke all on function public.finish_source_resolution_attempt(uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.claim_source_resolution_job() to service_role;
grant execute on function public.finish_source_resolution_attempt(uuid, integer, jsonb, text)
  to service_role;

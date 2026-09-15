-- Resolve the relevant segment against one exact immutable source analysis. Segment outcomes
-- remain append-only and independently measurable from both intent and source resolution.
alter table public.capture_analyses
  drop constraint capture_analyses_analysis_type_check;
alter table public.capture_analyses
  add constraint capture_analyses_analysis_type_check
    check (analysis_type in ('intent', 'source_resolution', 'segment_resolution'));

create function public.claim_segment_resolution_job()
returns setof public.capture_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.capture_jobs set status = 'failed', locked_at = null,
    last_error = case when status = 'pending' then 'attempts_exhausted' else 'lease_expired' end,
    updated_at = now()
    where job_type = 'segment_resolution' and attempts >= 3
      and (status = 'pending' or (status = 'processing'
        and (locked_at is null or locked_at < now() - interval '10 minutes')));

  return query with candidate as (
    select id from public.capture_jobs
    where job_type = 'segment_resolution' and source_analysis_id is not null and attempts < 3
      and ((status = 'pending' and available_at <= now())
        or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')))
    order by available_at, created_at, id for update skip locked limit 1
  ) update public.capture_jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now()
    from candidate c where j.id = c.id returning j.*;
end;
$$;

create function public.finish_segment_resolution_attempt(
  p_job_id uuid, p_attempt integer, p_record jsonb, p_error_code text default null
)
returns table (analysis_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.capture_jobs;
  safe_error text;
  result_status text;
  representation text;
begin
  select * into job from public.capture_jobs where id = p_job_id for update;
  if not found or job.job_type <> 'segment_resolution' or job.status <> 'processing'
     or job.attempts <> p_attempt or p_attempt is null
     or job.locked_at is null or job.locked_at < now() - interval '10 minutes' then
    return;
  end if;

  safe_error := case when p_error_code in (
    'capture_missing', 'source_missing', 'result_schema_invalid',
    'provider_response_invalid', 'provider_unavailable', 'segment_unavailable'
  ) then p_error_code
  when p_error_code is not null then 'provider_unavailable' else null end;
  if p_record is null and safe_error is null then raise exception 'invalid_attempt_record'; end if;
  if p_record is not null then
    if p_record->>'captureId' is distinct from job.capture_id::text
       or p_record->>'status' is distinct from (case when safe_error is null then 'succeeded' else 'failed' end)
       or p_record->'inputSnapshot'->'segmentJob'->>'id' is distinct from job.id::text
       or (p_record->'inputSnapshot'->'segmentJob'->>'attempt')::integer is distinct from p_attempt
       or p_record->'inputSnapshot'->'sourceAnalysis'->>'id' is distinct from job.source_analysis_id::text
       or not exists (
         select 1 from public.capture_analyses source
         where source.id = job.source_analysis_id and source.capture_id = job.capture_id
           and source.analysis_type = 'source_resolution' and source.status = 'succeeded'
       ) then
      raise exception 'invalid_attempt_record';
    end if;
    if safe_error is null then
      result_status := p_record->'result'->>'status';
      representation := p_record->'result'->>'representation';
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
           p_record->'result'->'representation' is distinct from 'null'::jsonb
           or p_record->'result'->'startSeconds' is distinct from 'null'::jsonb
           or p_record->'result'->'endSeconds' is distinct from 'null'::jsonb
           or p_record->'result'->'sectionStart' is distinct from 'null'::jsonb
           or p_record->'result'->'sectionEnd' is distinct from 'null'::jsonb
           or p_record->'result'->'excerpt' is distinct from 'null'::jsonb
           or p_record->'result'->'label' is distinct from 'null'::jsonb
         ))
         or (result_status = 'resolved' and (
           representation not in ('timed', 'text')
           or nullif(btrim(p_record->'result'->>'excerpt'), '') is null
           or nullif(btrim(p_record->>'modelId'), '') is null
           or (representation = 'timed' and (
             jsonb_typeof(p_record->'result'->'startSeconds') <> 'number'
             or jsonb_typeof(p_record->'result'->'endSeconds') <> 'number'
             or (p_record->'result'->>'startSeconds')::numeric < 0
             or (p_record->'result'->>'endSeconds')::numeric <= (p_record->'result'->>'startSeconds')::numeric
             or p_record->'result'->'sectionStart' is distinct from 'null'::jsonb
             or p_record->'result'->'sectionEnd' is distinct from 'null'::jsonb
           ))
           or (representation = 'text' and (
             p_record->'result'->'startSeconds' is distinct from 'null'::jsonb
             or p_record->'result'->'endSeconds' is distinct from 'null'::jsonb
           ))
         )) then raise exception 'invalid_segment_result'; end if;
    end if;
    insert into public.capture_analyses (
      capture_id, analysis_type, status, input_snapshot, result, confidence,
      model_id, prompt_version, pipeline_version, error_code
    ) values (
      job.capture_id, 'segment_resolution', p_record->>'status', p_record->'inputSnapshot',
      case when safe_error is null then p_record->'result' else null end,
      case when safe_error is null then (p_record->>'confidence')::numeric else null end,
      p_record->>'modelId', p_record->>'promptVersion', p_record->>'pipelineVersion', safe_error
    ) returning id into analysis_id;
  end if;

  if safe_error is null then
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = job.id;
  else
    update public.capture_jobs set status = case
        when safe_error in ('capture_missing', 'source_missing') or attempts >= 3 then 'failed'
        else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null,
      last_error = safe_error, updated_at = now() where id = job.id;
  end if;
  return next;
end;
$$;

revoke all on function public.claim_segment_resolution_job() from public, anon, authenticated;
revoke all on function public.finish_segment_resolution_attempt(uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.claim_segment_resolution_job() to service_role;
grant execute on function public.finish_segment_resolution_attempt(uuid, integer, jsonb, text)
  to service_role;

-- Extract a resolved article's complete readable text, or record honestly why it cannot be
-- narrated. Extractions are append-only, owned, and readable only after committed exposure.
alter table public.capture_jobs drop constraint capture_jobs_job_type_check;
alter table public.capture_jobs
  add constraint capture_jobs_job_type_check check (
    job_type in ('intent_analysis', 'source_resolution', 'segment_resolution', 'media_download',
      'email_enrichment', 'article_extraction')
  );

create unique index one_article_extraction_per_source_analysis
  on public.capture_jobs(source_analysis_id)
  where job_type = 'article_extraction';

create table public.capture_article_extractions (
  id uuid primary key default extensions.gen_random_uuid(),
  capture_id uuid not null,
  user_id uuid not null,
  source_analysis_id uuid not null unique references public.capture_analyses(id) on delete cascade,
  status text not null check (status in ('full', 'partial', 'unsupported', 'failed')),
  reason text check (reason in (
    'not_an_article', 'not_html', 'too_short', 'paywalled', 'truncated',
    'extraction_failed', 'fetch_failed'
  )),
  source_url text check (source_url is null or source_url ~ '^https://'),
  title text check (title is null or length(title) <= 500),
  byline text check (byline is null or length(byline) <= 500),
  site_name text check (site_name is null or length(site_name) <= 500),
  language text check (language is null or language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  paragraphs jsonb,
  word_count integer check (word_count is null or word_count >= 0),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  extractor_version text not null check (btrim(extractor_version) <> ''),
  created_at timestamptz not null default now(),
  foreign key (capture_id, user_id) references public.captures(id, user_id) on delete cascade,
  -- Only complete text is ever stored; every other outcome carries its reason and nothing else.
  check (
    (status = 'full' and reason is null and jsonb_typeof(paragraphs) = 'array'
      and jsonb_array_length(paragraphs) > 0 and word_count >= 200 and content_sha256 is not null)
    or (status = 'partial' and reason in ('paywalled', 'truncated')
      and paragraphs is null and content_sha256 is null)
    or (status = 'unsupported' and reason in ('not_an_article', 'not_html', 'too_short', 'extraction_failed')
      and paragraphs is null and content_sha256 is null)
    or (status = 'failed' and reason in ('fetch_failed', 'extraction_failed')
      and paragraphs is null and content_sha256 is null)
  )
);
create index capture_article_extractions_capture_idx
  on public.capture_article_extractions (capture_id, created_at desc, id);

create function public.prevent_capture_article_extraction_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'article extractions are immutable' using errcode = '55000';
end;
$$;
create trigger prevent_capture_article_extraction_update
  before update on public.capture_article_extractions
  for each row execute function public.prevent_capture_article_extraction_update();

alter table public.capture_article_extractions enable row level security;
create policy "owners read exposed article extractions"
  on public.capture_article_extractions for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.capture_revisit_state s
      where s.capture_id = capture_article_extractions.capture_id
        and s.user_id = (select auth.uid()) and s.first_exposed_at is not null
    )
  );
revoke all on public.capture_article_extractions from anon, authenticated;
grant select on public.capture_article_extractions to authenticated;

-- Route every published source outcome. Only a resolved article is fetched; anything else is
-- recorded as not narratable here so nothing downstream has to guess.
create function public.route_article_extraction()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.analysis_type <> 'source_resolution' or new.status <> 'succeeded' then
    return null;
  end if;
  if new.result->>'status' = 'resolved' and new.result->>'sourceType' = 'article' then
    insert into public.capture_jobs(capture_id, job_type, source_analysis_id)
      values (new.capture_id, 'article_extraction', new.id)
      on conflict do nothing;
  else
    insert into public.capture_article_extractions(
      capture_id, user_id, source_analysis_id, status, reason, source_url, extractor_version
    )
    select new.capture_id, c.user_id, new.id, 'unsupported', 'not_an_article',
      case when new.result->>'canonicalUrl' ~ '^https://' then new.result->>'canonicalUrl' end,
      'article-extraction-v1'
    from public.captures c where c.id = new.capture_id
    on conflict (source_analysis_id) do nothing;
  end if;
  return null;
end;
$$;
create trigger route_article_extraction
  after insert on public.capture_analyses
  for each row execute function public.route_article_extraction();

create function public.claim_article_extraction_job()
returns setof public.capture_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Exhausted work still ends in an honest terminal record rather than silently vanishing.
  with exhausted as (
    update public.capture_jobs set status = 'failed', locked_at = null,
      last_error = case when status = 'pending' then 'attempts_exhausted' else 'lease_expired' end,
      updated_at = now()
      where job_type = 'article_extraction' and attempts >= 3
        and (status = 'pending' or (status = 'processing'
          and (locked_at is null or locked_at < now() - interval '10 minutes')))
      returning capture_id, source_analysis_id, last_error
  )
  insert into public.capture_article_extractions(
    capture_id, user_id, source_analysis_id, status, reason, source_url, extractor_version
  )
  select e.capture_id, c.user_id, e.source_analysis_id, 'failed',
    case when e.last_error = 'attempts_exhausted' then 'fetch_failed' else 'extraction_failed' end,
    case when a.result->>'canonicalUrl' ~ '^https://' then a.result->>'canonicalUrl' end,
    'article-extraction-v1'
  from exhausted e
  join public.captures c on c.id = e.capture_id
  join public.capture_analyses a on a.id = e.source_analysis_id
  on conflict (source_analysis_id) do nothing;

  return query with candidate as (
    select id from public.capture_jobs
    where job_type = 'article_extraction' and source_analysis_id is not null and attempts < 3
      and ((status = 'pending' and available_at <= now())
        or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')))
    order by available_at, created_at, id for update skip locked limit 1
  ) update public.capture_jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now()
    from candidate c where j.id = c.id returning j.*;
end;
$$;

create function public.finish_article_extraction_attempt(
  p_job_id uuid, p_attempt integer, p_record jsonb, p_error_code text default null
)
returns table (extraction_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.capture_jobs;
  owner_id uuid;
  safe_error text;
  record_status text;
  v_paragraphs jsonb;
  v_source_url text;
begin
  select * into job from public.capture_jobs where id = p_job_id for update;
  if not found or job.job_type <> 'article_extraction' or job.status <> 'processing'
     or job.attempts <> p_attempt or p_attempt is null
     or job.locked_at is null or job.locked_at < now() - interval '10 minutes' then
    return;
  end if;

  safe_error := case when p_error_code in ('capture_missing', 'source_missing', 'fetch_failed')
    then p_error_code
  when p_error_code is not null then 'fetch_failed' else null end;
  if (p_record is null) = (safe_error is null) then raise exception 'invalid_attempt_record'; end if;

  select c.user_id into owner_id from public.captures c where c.id = job.capture_id;
  select case when a.result->>'canonicalUrl' ~ '^https://' then a.result->>'canonicalUrl' end
    into v_source_url from public.capture_analyses a
    where a.id = job.source_analysis_id and a.capture_id = job.capture_id
      and a.analysis_type = 'source_resolution' and a.status = 'succeeded';

  if safe_error is null then
    record_status := p_record->>'status';
    v_paragraphs := p_record->'paragraphs';
    if p_record->>'captureId' is distinct from job.capture_id::text or owner_id is null
       or record_status not in ('full', 'partial', 'unsupported')
       or (record_status = 'full' and (
         jsonb_typeof(v_paragraphs) is distinct from 'array'
         or jsonb_array_length(v_paragraphs) = 0
         or exists (select 1 from jsonb_array_elements(v_paragraphs) p(value)
           where jsonb_typeof(p.value) <> 'string' or btrim(p.value #>> '{}') = '')
       ))
       or (record_status <> 'full' and v_paragraphs is not null and v_paragraphs <> 'null'::jsonb) then
      raise exception 'invalid_article_extraction';
    end if;
    if record_status <> 'full' then v_paragraphs := null; end if;
    insert into public.capture_article_extractions(
      capture_id, user_id, source_analysis_id, status, reason, source_url, title, byline,
      site_name, language, paragraphs, word_count, content_sha256, extractor_version
    ) values (
      job.capture_id, owner_id, job.source_analysis_id, record_status, p_record->>'reason',
      coalesce(nullif(p_record->>'sourceUrl', ''), v_source_url),
      p_record->>'title', p_record->>'byline', p_record->>'siteName', p_record->>'language',
      v_paragraphs, (p_record->>'wordCount')::integer,
      -- The digest is the database's own, over exactly the stored paragraphs in order.
      case when v_paragraphs is not null then encode(pg_catalog.sha256(convert_to(
        (select string_agg(p.value, E'\n\n' order by p.ordinality)
          from jsonb_array_elements_text(v_paragraphs) with ordinality p(value, ordinality)),
        'UTF8')), 'hex') end,
      p_record->>'extractorVersion'
    ) on conflict (source_analysis_id) do nothing
    returning id into extraction_id;
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = job.id;
  else
    if safe_error = 'fetch_failed' and job.attempts >= 3 and owner_id is not null then
      insert into public.capture_article_extractions(
        capture_id, user_id, source_analysis_id, status, reason, source_url, extractor_version
      ) values (
        job.capture_id, owner_id, job.source_analysis_id, 'failed', 'fetch_failed', v_source_url,
        'article-extraction-v1'
      ) on conflict (source_analysis_id) do nothing
      returning id into extraction_id;
    end if;
    update public.capture_jobs set status = case
        when safe_error in ('capture_missing', 'source_missing') or attempts >= 3 then 'failed'
        else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null,
      last_error = safe_error, updated_at = now() where id = job.id;
  end if;
  return next;
end;
$$;

revoke all on function public.prevent_capture_article_extraction_update() from public, anon, authenticated;
revoke all on function public.route_article_extraction() from public, anon, authenticated;
revoke all on function public.claim_article_extraction_job() from public, anon, authenticated;
revoke all on function public.finish_article_extraction_attempt(uuid, integer, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.claim_article_extraction_job() to service_role;
grant execute on function public.finish_article_extraction_attempt(uuid, integer, jsonb, text)
  to service_role;

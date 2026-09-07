-- Media work joins the existing atomic capture transaction.
-- Original metadata is immutable; observations are separate columns.
alter table public.capture_assets
  add column storage_state text not null default 'pending' check (storage_state in ('pending', 'stored', 'failed')),
  add column observed_media_type text,
  add column stored_byte_size bigint check (stored_byte_size > 0),
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column stored_at timestamptz,
  add column storage_error text,
  add constraint stored_asset_evidence check (storage_state <> 'stored' or
    (observed_media_type is not null and stored_byte_size is not null and sha256 is not null and stored_at is not null)),
  add constraint capture_assets_identity unique (id, capture_id);

alter table public.capture_jobs drop constraint capture_jobs_job_type_check;
alter table public.capture_jobs
  add constraint capture_jobs_job_type_check check (job_type in ('intent_analysis', 'source_resolution', 'media_download')),
  add column asset_id uuid,
  add column intent_phase text not null default 'initial' check (intent_phase in ('initial', 'enriched')),
  add constraint media_job_asset foreign key (asset_id, capture_id) references public.capture_assets(id, capture_id) on delete cascade,
  add constraint media_job_identity check ((job_type = 'media_download') = (asset_id is not null)),
  add constraint enriched_intent_only check (intent_phase = 'initial' or job_type = 'intent_analysis');
create unique index one_download_per_asset on public.capture_jobs(asset_id) where job_type = 'media_download';
create unique index one_enrichment_per_capture on public.capture_jobs(capture_id)
  where job_type = 'intent_analysis' and intent_phase = 'enriched';

-- Serialize terminal transitions per capture. The unique index also protects against
-- retries. Wait for the initial attempt sequence, so enrichment always appends later.
create function public.enqueue_media_enrichment(p_capture_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.captures where id = p_capture_id for update;
  if exists (select 1 from public.capture_jobs where capture_id = p_capture_id and job_type = 'media_download')
     and not exists (select 1 from public.capture_assets where capture_id = p_capture_id and storage_state = 'pending')
     and exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type = 'intent_analysis' and intent_phase = 'initial' and status in ('completed', 'failed'))
     and not exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type = 'intent_analysis' and intent_phase = 'initial' and status in ('pending', 'processing')) then
    insert into public.capture_jobs(capture_id, job_type, intent_phase)
      values (p_capture_id, 'intent_analysis', 'enriched') on conflict do nothing;
  end if;
end;
$$;

create function public.media_terminal_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    if new.job_type = 'media_download' and new.status = 'failed' then
      update public.capture_assets set storage_state = 'failed', storage_error = new.last_error
        where id = new.asset_id and storage_state = 'pending';
    end if;
    if new.job_type = 'media_download' or (new.job_type = 'intent_analysis' and new.intent_phase = 'initial') then
      perform public.enqueue_media_enrichment(new.capture_id);
    end if;
  end if;
  return new;
end;
$$;
create trigger media_terminal_transition after update of status on public.capture_jobs
  for each row execute function public.media_terminal_transition();

create function public.claim_media_job()
returns setof public.capture_jobs language plpgsql security definer set search_path = '' as $$
begin
  update public.capture_jobs set status = 'failed', locked_at = null, last_error = 'attempts_exhausted', updated_at = now()
    where job_type = 'media_download' and attempts >= 3
      and (status = 'pending' or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')));
  return query with candidate as (
    select id from public.capture_jobs where job_type = 'media_download' and attempts < 3
      and ((status = 'pending' and available_at <= now())
        or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')))
      order by available_at, created_at, id for update skip locked limit 1
  ) update public.capture_jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now() from candidate c where j.id = c.id returning j.*;
end;
$$;

create function public.finish_media_attempt(p_job_id uuid, p_attempt integer, p_evidence jsonb, p_error_code text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.capture_jobs; safe_error text;
begin
  select * into j from public.capture_jobs where id = p_job_id for update;
  if not found or j.job_type <> 'media_download' or j.status <> 'processing'
     or p_attempt is null or j.attempts <> p_attempt or j.locked_at is null
     or j.locked_at < now() - interval '10 minutes' then return false; end if;
  safe_error := case when p_error_code in ('unsafe_origin', 'unsafe_redirect', 'media_too_large',
    'media_mismatch', 'unsafe_media', 'media_missing', 'storage_conflict') then p_error_code
    when p_error_code is not null then 'media_unavailable' else null end;
  if safe_error is null then
    if p_evidence is null or p_evidence->>'mediaType' is null
      or (p_evidence->>'byteSize')::bigint is null or (p_evidence->>'sha256') is null then
      raise exception 'invalid_media_evidence';
    end if;
    update public.capture_assets set storage_state = 'stored', observed_media_type = p_evidence->>'mediaType',
      stored_byte_size = (p_evidence->>'byteSize')::bigint, sha256 = p_evidence->>'sha256', stored_at = now(), storage_error = null
      where id = j.asset_id;
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = j.id;
  else
    -- Invalid input is terminal immediately. Transient network/storage failures get
    -- three attempts with the same bounded backoff as intent work.
    update public.capture_jobs set status = case when safe_error <> 'media_unavailable' or attempts >= 3 then 'failed' else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null, last_error = safe_error, updated_at = now()
      where id = j.id;
  end if;
  return true;
end;
$$;
revoke all on function public.enqueue_media_enrichment(uuid) from public, anon, authenticated;
revoke all on function public.media_terminal_transition() from public, anon, authenticated;
revoke all on function public.claim_media_job() from public, anon, authenticated;
revoke all on function public.finish_media_attempt(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_media_job() to service_role;
grant execute on function public.finish_media_attempt(uuid, integer, jsonb, text) to service_role;

create or replace function public.persist_capture_with_intent_job(
  p_user_id uuid,
  p_capture_channel text,
  p_external_message_id text,
  p_capture_kind text,
  p_raw_text text,
  p_user_note text,
  p_source_platform text,
  p_captured_at timestamptz,
  p_raw_payload jsonb,
  p_assets jsonb
)
returns table (capture_id uuid, intent_job_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capture_id uuid;
  v_job_id uuid;
  v_created boolean := false;
  v_asset jsonb;
  v_asset_id uuid;
  v_ordinal bigint;
  v_filename text;
begin
  if p_raw_payload is null or jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'raw payload must be a JSON object' using errcode = '22023';
  end if;

  if p_assets is null or jsonb_typeof(p_assets) <> 'array' then
    raise exception 'assets must be a JSON array' using errcode = '22023';
  end if;

  if p_external_message_id is not null then
    select c.id into v_capture_id
    from public.captures c
    where c.user_id = p_user_id
      and c.capture_channel = p_capture_channel
      and c.external_message_id = p_external_message_id;
  end if;

  if v_capture_id is null then
    insert into public.captures (
      user_id, capture_channel, external_message_id, capture_kind, raw_text,
      user_note, source_platform, captured_at, raw_payload
    ) values (
      p_user_id, p_capture_channel, p_external_message_id, p_capture_kind, p_raw_text,
      p_user_note, p_source_platform, p_captured_at, p_raw_payload
    )
    on conflict (user_id, capture_channel, external_message_id)
      where external_message_id is not null
    do nothing
    returning id into v_capture_id;

    if v_capture_id is null then
      select c.id into strict v_capture_id
      from public.captures c
      where c.user_id = p_user_id
        and c.capture_channel = p_capture_channel
        and c.external_message_id = p_external_message_id;
    else
      v_created := true;
    end if;
  end if;

  if v_created then
    for v_asset, v_ordinal in
      select value, ordinality
      from jsonb_array_elements(p_assets) with ordinality
    loop
      v_filename := coalesce(
        nullif(btrim(v_asset ->> 'fileName'), ''),
        nullif(btrim(v_asset ->> 'id'), ''),
        'asset-' || v_ordinal::text
      );
      v_filename := regexp_replace(v_filename, '[^A-Za-z0-9._-]+', '-', 'g');

      insert into public.capture_assets (
        capture_id, storage_path, filename, media_type, byte_size, metadata
      ) values (
        v_capture_id,
        'captures/' || p_user_id::text || '/' || v_capture_id::text || '/' || v_ordinal::text || '-' || v_filename,
        v_filename,
        nullif(v_asset ->> 'contentType', ''),
        case when v_asset ? 'sizeBytes' then (v_asset ->> 'sizeBytes')::bigint else null end,
        v_asset
      ) returning id into v_asset_id;
      if p_capture_channel = 'whatsapp' then
        insert into public.capture_jobs(capture_id, job_type, asset_id)
          values (v_capture_id, 'media_download', v_asset_id);
      end if;
    end loop;

    insert into public.capture_jobs (capture_id, job_type, status)
    values (v_capture_id, 'intent_analysis', 'pending')
    returning id into v_job_id;
  else
    select j.id into strict v_job_id
    from public.capture_jobs j
    where j.capture_id = v_capture_id
      and j.job_type = 'intent_analysis'
    order by j.created_at, j.id
    limit 1;
  end if;

  return query select v_capture_id, v_job_id, v_created;
end;
$$;

revoke all on function public.persist_capture_with_intent_job(
  uuid, text, text, text, text, text, text, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_capture_with_intent_job(
  uuid, text, text, text, text, text, text, timestamptz, jsonb, jsonb
) to service_role;

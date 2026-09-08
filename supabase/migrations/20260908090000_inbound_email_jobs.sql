-- Inbound email joins the same capture transaction and the same asset lifecycle as WhatsApp
-- media. One received message is one capture; its parsed body and its attachments are assets
-- whose bytes arrive later, from a background job, into the same private bucket.
alter table public.captures drop constraint captures_capture_kind_check;
alter table public.captures add constraint captures_capture_kind_check check (
  capture_kind in ('text', 'url', 'link', 'attachment', 'email', 'mixed', 'unknown')
);

alter table public.capture_jobs drop constraint capture_jobs_job_type_check;
alter table public.capture_jobs add constraint capture_jobs_job_type_check
  check (job_type in ('intent_analysis', 'source_resolution', 'media_download', 'email_enrichment'));
create unique index one_email_enrichment_per_capture on public.capture_jobs(capture_id)
  where job_type = 'email_enrichment';

-- Enrichment is scheduled once every asset has reached a terminal storage state, the retrieval
-- job itself is terminal, and the initial attempt sequence has finished — so an enriched run can
-- only ever append after the metadata-only one, never race it.
create or replace function public.enqueue_media_enrichment(p_capture_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.captures where id = p_capture_id for update;
  if exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type in ('media_download', 'email_enrichment'))
     and not exists (select 1 from public.capture_assets where capture_id = p_capture_id and storage_state = 'pending')
     and not exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type = 'email_enrichment' and status in ('pending', 'processing'))
     and exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type = 'intent_analysis' and intent_phase = 'initial' and status in ('completed', 'failed'))
     and not exists (select 1 from public.capture_jobs where capture_id = p_capture_id
       and job_type = 'intent_analysis' and intent_phase = 'initial' and status in ('pending', 'processing')) then
    insert into public.capture_jobs(capture_id, job_type, intent_phase)
      values (p_capture_id, 'intent_analysis', 'enriched') on conflict do nothing;
  end if;
end;
$$;

-- A terminally failed retrieval leaves nothing pending: assets it never reached become failed
-- with the job's own safe code, so a stalled asset can never read as "still coming".
create or replace function public.media_terminal_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('completed', 'failed') and old.status is distinct from new.status then
    if new.job_type = 'media_download' and new.status = 'failed' then
      update public.capture_assets set storage_state = 'failed', storage_error = new.last_error
        where id = new.asset_id and storage_state = 'pending';
    end if;
    if new.job_type = 'email_enrichment' and new.status = 'failed' then
      update public.capture_assets set storage_state = 'failed',
        storage_error = coalesce(new.last_error, 'email_unavailable')
        where capture_id = new.capture_id and storage_state = 'pending';
    end if;
    if new.job_type in ('media_download', 'email_enrichment')
       or (new.job_type = 'intent_analysis' and new.intent_phase = 'initial') then
      perform public.enqueue_media_enrichment(new.capture_id);
    end if;
  end if;
  return new;
end;
$$;

create function public.claim_email_enrichment_job()
returns setof public.capture_jobs language plpgsql security definer set search_path = '' as $$
begin
  update public.capture_jobs set status = 'failed', locked_at = null, last_error = 'attempts_exhausted', updated_at = now()
    where job_type = 'email_enrichment' and attempts >= 3
      and (status = 'pending' or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')));
  return query with candidate as (
    select id from public.capture_jobs where job_type = 'email_enrichment' and attempts < 3
      and ((status = 'pending' and available_at <= now())
        or (status = 'processing' and (locked_at is null or locked_at < now() - interval '10 minutes')))
      order by available_at, created_at, id for update skip locked limit 1
  ) update public.capture_jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now() from candidate c where j.id = c.id returning j.*;
end;
$$;

-- One asset reaches its terminal state, fenced by the claimed attempt. Original provider
-- metadata is never rewritten and a stored object is never re-stamped.
create function public.finish_email_asset(p_job_id uuid, p_attempt integer, p_asset_id uuid,
  p_evidence jsonb, p_error_code text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.capture_jobs; safe_error text;
begin
  select * into j from public.capture_jobs where id = p_job_id for update;
  if not found or j.job_type <> 'email_enrichment' or j.status <> 'processing'
     or p_attempt is null or j.attempts <> p_attempt or j.locked_at is null
     or j.locked_at < now() - interval '10 minutes' then return false; end if;
  if not exists (select 1 from public.capture_assets
    where id = p_asset_id and capture_id = j.capture_id) then return false; end if;
  safe_error := case when p_error_code in ('unsafe_origin', 'unsafe_redirect', 'media_too_large',
    'media_mismatch', 'unsafe_media', 'media_missing', 'storage_conflict', 'attachment_missing',
    'email_too_large', 'email_missing', 'email_response_invalid') then p_error_code
    when p_error_code is not null then 'email_unavailable' else null end;
  if safe_error is null then
    if p_evidence is null or p_evidence->>'mediaType' is null
      or (p_evidence->>'byteSize')::bigint is null or (p_evidence->>'sha256') is null then
      raise exception 'invalid_media_evidence';
    end if;
    update public.capture_assets set storage_state = 'stored', observed_media_type = p_evidence->>'mediaType',
      stored_byte_size = (p_evidence->>'byteSize')::bigint, sha256 = p_evidence->>'sha256',
      stored_at = now(), storage_error = null
      where id = p_asset_id and storage_state = 'pending';
  else
    update public.capture_assets set storage_state = 'failed', storage_error = safe_error
      where id = p_asset_id and storage_state = 'pending';
  end if;
  return true;
end;
$$;

-- The attempt itself. Terminal codes fail immediately; transient ones get the same three
-- attempts and bounded backoff as every other queue here.
create function public.finish_email_enrichment_attempt(p_job_id uuid, p_attempt integer,
  p_error_code text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.capture_jobs; safe_error text;
begin
  select * into j from public.capture_jobs where id = p_job_id for update;
  if not found or j.job_type <> 'email_enrichment' or j.status <> 'processing'
     or p_attempt is null or j.attempts <> p_attempt or j.locked_at is null
     or j.locked_at < now() - interval '10 minutes' then return false; end if;
  safe_error := case when p_error_code in ('unsafe_origin', 'unsafe_redirect', 'media_too_large',
    'media_mismatch', 'unsafe_media', 'media_missing', 'storage_conflict', 'attachment_missing',
    'email_too_large', 'email_missing', 'email_response_invalid', 'email_configuration_invalid',
    'capture_missing') then p_error_code
    when p_error_code is not null then 'email_unavailable' else null end;
  if safe_error is null then
    update public.capture_jobs set status = 'completed', completed_at = now(), locked_at = null,
      last_error = null, updated_at = now() where id = j.id;
  else
    update public.capture_jobs set status = case when safe_error <> 'email_unavailable' or attempts >= 3 then 'failed' else 'pending' end,
      available_at = now() + make_interval(mins => attempts), locked_at = null, last_error = safe_error, updated_at = now()
      where id = j.id;
  end if;
  return true;
end;
$$;

revoke all on function public.claim_email_enrichment_job() from public, anon, authenticated;
revoke all on function public.finish_email_asset(uuid, integer, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.finish_email_enrichment_attempt(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_email_enrichment_job() to service_role;
grant execute on function public.finish_email_asset(uuid, integer, uuid, jsonb, text) to service_role;
grant execute on function public.finish_email_enrichment_attempt(uuid, integer, text) to service_role;

-- The capture transaction gains one email_enrichment job, exactly as WhatsApp gains one
-- media_download job per asset. A replayed webhook re-enters the idempotent branch and creates
-- neither, so one email id is always one capture, one initial intent job and one enrichment job.
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

    if p_capture_channel = 'email' then
      insert into public.capture_jobs(capture_id, job_type)
        values (v_capture_id, 'email_enrichment');
    end if;

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

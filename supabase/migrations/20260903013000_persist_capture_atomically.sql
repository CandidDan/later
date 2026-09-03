alter table public.captures drop constraint captures_capture_kind_check;
alter table public.captures add constraint captures_capture_kind_check check (
  capture_kind in ('text', 'url', 'link', 'attachment', 'mixed', 'unknown')
);

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
      );
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

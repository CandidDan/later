create extension if not exists pgcrypto with schema extensions;

create table public.captures (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_channel text not null check (capture_channel = btrim(capture_channel) and capture_channel <> ''),
  external_message_id text check (
    external_message_id is null
    or (external_message_id = btrim(external_message_id) and external_message_id <> '')
  ),
  capture_kind text not null default 'unknown' check (
    capture_kind in ('text', 'url', 'attachment', 'mixed', 'unknown')
  ),
  raw_text text,
  user_note text,
  source_platform text check (
    source_platform is null or source_platform in ('instagram', 'youtube', 'spotify')
  ),
  captured_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index captures_provider_message_uidx
  on public.captures (capture_channel, external_message_id)
  where external_message_id is not null;
create index captures_user_chronological_idx
  on public.captures (user_id, captured_at desc, id);

create table public.capture_assets (
  id uuid primary key default extensions.gen_random_uuid(),
  capture_id uuid not null references public.captures(id) on delete cascade,
  storage_path text not null unique check (storage_path = btrim(storage_path) and storage_path <> ''),
  filename text not null check (filename = btrim(filename) and filename <> ''),
  media_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index capture_assets_capture_idx on public.capture_assets (capture_id, created_at, id);

create table public.capture_analyses (
  id uuid primary key default extensions.gen_random_uuid(),
  capture_id uuid not null references public.captures(id) on delete cascade,
  analysis_type text not null check (analysis_type in ('intent')),
  status text not null check (status in ('succeeded', 'failed')),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  confidence numeric check (confidence is null or confidence between 0 and 1),
  model_id text,
  prompt_version text not null,
  pipeline_version text not null,
  error_code text,
  created_at timestamptz not null default now(),
  check (
    (status = 'succeeded' and result is not null and model_id is not null and error_code is null)
    or (status = 'failed' and result is null and error_code is not null)
  )
);
create index capture_analyses_capture_idx
  on public.capture_analyses (capture_id, created_at desc, id);

create table public.capture_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  capture_id uuid not null references public.captures(id) on delete cascade,
  job_type text not null check (job_type in ('intent_analysis', 'source_resolution')),
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'completed' or completed_at is not null)
);
create index capture_jobs_pending_idx
  on public.capture_jobs (available_at, created_at, id)
  where status = 'pending';
create index capture_jobs_capture_idx on public.capture_jobs (capture_id, created_at, id);

insert into storage.buckets (id, name, public)
values ('capture-assets', 'capture-assets', false)
on conflict (id) do update set public = false;

alter table public.captures enable row level security;
alter table public.capture_assets enable row level security;
alter table public.capture_analyses enable row level security;
alter table public.capture_jobs enable row level security;

create policy "owners read captures"
  on public.captures for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "owners permanently delete captures"
  on public.captures for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "owners read capture assets"
  on public.capture_assets for select to authenticated
  using (exists (
    select 1 from public.captures
    where captures.id = capture_assets.capture_id
      and captures.user_id = (select auth.uid())
  ));

create policy "owners read capture analyses"
  on public.capture_analyses for select to authenticated
  using (exists (
    select 1 from public.captures
    where captures.id = capture_analyses.capture_id
      and captures.user_id = (select auth.uid())
  ));

create policy "owners read capture jobs"
  on public.capture_jobs for select to authenticated
  using (exists (
    select 1 from public.captures
    where captures.id = capture_jobs.capture_id
      and captures.user_id = (select auth.uid())
  ));

create policy "owners read capture storage objects"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'capture-assets'
    and (storage.foldername(name))[1] = 'captures'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and exists (
      select 1 from public.captures
      where captures.id::text = (storage.foldername(name))[3]
        and captures.user_id = (select auth.uid())
    )
  );

revoke all on public.captures, public.capture_assets, public.capture_analyses, public.capture_jobs
  from anon, authenticated;
grant select, delete on public.captures to authenticated;
grant select on public.capture_assets, public.capture_analyses, public.capture_jobs to authenticated;

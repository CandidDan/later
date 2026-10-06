-- Revisit metadata never mutates capture evidence or frozen analyses.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.captures'::regclass and conname='captures_id_user_key') then
    alter table public.captures add constraint captures_id_user_key unique (id, user_id);
  end if;
end $$;
create table if not exists public.capture_revisit_state (
  capture_id uuid primary key,
  user_id uuid not null,
  first_exposed_at timestamptz,
  deferred_until timestamptz,
  consumed_at timestamptz,
  foreign key (capture_id, user_id) references public.captures(id, user_id) on delete cascade
);
create table if not exists public.capture_revisit_events (
  user_id uuid not null,
  request_id uuid not null,
  capture_id uuid not null,
  action text not null check (action in ('open', 'defer', 'consume')),
  destination text,
  occurred_at timestamptz not null default clock_timestamp(),
  primary key (user_id, request_id),
  foreign key (capture_id, user_id) references public.captures(id, user_id) on delete cascade,
  check ((action = 'open' and destination is not null) or (action <> 'open' and destination is null))
);
alter table public.capture_revisit_state enable row level security;
alter table public.capture_revisit_events enable row level security;
drop policy if exists "owners read revisit state" on public.capture_revisit_state;
create policy "owners read revisit state" on public.capture_revisit_state for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "owners read revisit events" on public.capture_revisit_events;
create policy "owners read revisit events" on public.capture_revisit_events for select to authenticated using (user_id = (select auth.uid()));
-- Only the authenticated RPCs can write metadata or choose its timestamps.
revoke all on public.capture_revisit_state, public.capture_revisit_events from anon, authenticated;
grant select on public.capture_revisit_state, public.capture_revisit_events to authenticated;

create or replace function public.revisit_expose(p_capture_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  -- This same owned row lock is taken by recall writes, including direct inserts.
  perform 1 from public.captures where id = p_capture_id and user_id = auth.uid() for update;
  if not found then return false; end if;
  insert into public.capture_revisit_state(capture_id, user_id, first_exposed_at)
  values (p_capture_id, auth.uid(), clock_timestamp())
  on conflict (capture_id) do update set first_exposed_at = coalesce(public.capture_revisit_state.first_exposed_at, excluded.first_exposed_at);
  return true;
end $$;

create or replace function public.revisit_batch()
returns setof uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_now timestamptz := clock_timestamp();
begin
  for v_id in select c.id from public.captures c
    left join public.capture_revisit_state s on s.capture_id = c.id
    where c.user_id = auth.uid() and s.consumed_at is null
      and (s.deferred_until is null or s.deferred_until <= v_now)
    order by c.captured_at, c.id limit 3
  loop
    -- Recheck after locking: a simultaneous action may have changed eligibility.
    perform 1 from public.captures where id = v_id and user_id = auth.uid() for update;
    if not found then continue; end if;
    if exists (select 1 from public.capture_revisit_state where capture_id = v_id
      and (consumed_at is not null or deferred_until > v_now)) then continue; end if;
    if public.revisit_expose(v_id) then return next v_id; end if;
  end loop;
end $$;

create or replace function public.revisit_action(p_capture_id uuid, p_request_id uuid, p_action text, p_destination text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_event public.capture_revisit_events; v_now timestamptz;
begin
  if p_request_id is null or p_action is null or p_action not in ('open','defer','consume') then
    raise exception 'Invalid action' using errcode = '22023';
  end if;
  -- Request-id lock first, then capture lock: retries across different captures cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || p_request_id::text, 0));
  perform 1 from public.captures where id = p_capture_id and user_id = auth.uid() for update;
  if not found then raise exception 'Unavailable' using errcode = '42501'; end if;
  select * into v_event from public.capture_revisit_events where user_id = auth.uid() and request_id = p_request_id;
  if found then
    if v_event.capture_id <> p_capture_id or v_event.action <> p_action then
      raise exception 'Request conflict' using errcode = '22023';
    end if;
    return jsonb_build_object('status','applied','repeated',true,'action',v_event.action,'occurredAt',v_event.occurred_at,'destination',v_event.destination);
  end if;
  if p_action = 'open' and (p_destination is null or length(p_destination) > 2000
    or p_destination !~ '^https://[^/@[:space:]]+\.[^/@[:space:]]+([/?#]|$)'
    or p_destination ~ '[[:cntrl:]]') then
    raise exception 'Destination unavailable' using errcode = '22023';
  end if;
  -- An authenticated caller cannot invent a destination unrelated to the owned save.
  -- The HTTP boundary additionally validates public DNS immediately before returning it.
  if p_action = 'open' and not (
    exists(select 1 from public.captures c,
      lateral regexp_matches(coalesce(c.raw_text,''), 'https?://[^\s<>"'']+', 'g') candidate
      where c.id=p_capture_id and (p_destination=candidate[1] or p_destination=candidate[1] || '/'))
    or exists(select 1 from (
      select a.result from public.capture_analyses a where a.capture_id=p_capture_id
        and a.analysis_type='source_resolution' and a.status='succeeded'
      order by a.created_at desc,a.id desc limit 1) latest
      where latest.result->>'status'='resolved' and (p_destination=latest.result->>'canonicalUrl'
        or p_destination=(latest.result->>'canonicalUrl') || '/'))
  ) then raise exception 'Destination unavailable' using errcode = '22023'; end if;
  if p_action <> 'open' and p_destination is not null then raise exception 'Invalid action' using errcode = '22023'; end if;
  v_now := clock_timestamp();
  insert into public.capture_revisit_state(capture_id,user_id) values(p_capture_id,auth.uid()) on conflict do nothing;
  if p_action = 'defer' then update public.capture_revisit_state set deferred_until = v_now + interval '7 days' where capture_id = p_capture_id;
  elsif p_action = 'consume' then update public.capture_revisit_state set consumed_at = coalesce(consumed_at,v_now) where capture_id = p_capture_id;
  end if;
  insert into public.capture_revisit_events(user_id,request_id,capture_id,action,destination,occurred_at)
    values(auth.uid(),p_request_id,p_capture_id,p_action,p_destination,v_now);
  return jsonb_build_object('status','applied','repeated',false,'action',p_action,'occurredAt',v_now,'destination',p_destination);
end $$;

create or replace function public.capture_recall_exposure_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_existing public.capture_evaluations;
begin
  perform 1 from public.captures where id = new.capture_id and user_id = new.evaluator_id for update;
  if not found then raise exception 'Unavailable' using errcode = '42501'; end if;
  select * into v_existing from public.capture_evaluations where capture_id = new.capture_id and evaluator_id = new.evaluator_id order by created_at, id limit 1;
  if found then
    -- New runs reuse the original recall, never a fresh answer after exposure.
    new.recall_status := v_existing.recall_status;
    new.remembered_interest := v_existing.remembered_interest;
    new.recalled_at := v_existing.recalled_at;
  elsif exists (select 1 from public.capture_revisit_state where capture_id = new.capture_id and first_exposed_at is not null) then
    raise exception 'Capture already exposed' using errcode = '23514';
  else
    new.recalled_at := clock_timestamp();
  end if;
  return new;
end $$;
drop trigger if exists capture_recall_exposure_before_insert on public.capture_evaluations;
create trigger capture_recall_exposure_before_insert before insert on public.capture_evaluations for each row execute function public.capture_recall_exposure_guard();

create or replace function public.research_record_recall(p_capture_id uuid, p_recall_status text, p_remembered_interest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing public.capture_evaluations; v_runs integer; v_inserted integer;
begin
  perform 1 from public.captures where id = p_capture_id and user_id = auth.uid() for update;
  if not found then raise exception 'Unavailable' using errcode = '42501'; end if;
  select * into v_existing from public.capture_evaluations where capture_id = p_capture_id and evaluator_id = auth.uid() order by created_at,id limit 1;
  if not found and exists(select 1 from public.capture_revisit_state where capture_id = p_capture_id and first_exposed_at is not null) then
    return jsonb_build_object('status','exposed');
  end if;
  select count(*) into v_runs from public.capture_analyses where capture_id = p_capture_id and analysis_type = 'intent' and status = 'succeeded';
  if v_runs = 0 then return jsonb_build_object('status','no_eligible_runs'); end if;
  insert into public.capture_evaluations(capture_id,analysis_id,evaluator_id,recall_status,remembered_interest)
    select p_capture_id,a.id,auth.uid(),coalesce(v_existing.recall_status,p_recall_status),
      case when v_existing.id is not null then v_existing.remembered_interest else p_remembered_interest end
    from public.capture_analyses a where a.capture_id = p_capture_id and a.analysis_type = 'intent' and a.status = 'succeeded'
    on conflict (evaluator_id,analysis_id) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('captureId',p_capture_id,'runs',v_runs,'repeated',v_inserted = 0);
end $$;

create or replace view public.research_pending_evaluations with (security_invoker = true) as
select c.id as capture_id,c.user_id,c.capture_channel,c.capture_kind,c.raw_text,c.user_note,c.source_platform,c.captured_at,
  exists(select 1 from public.capture_evaluations e where e.capture_id=c.id and e.evaluator_id=c.user_id) as recall_stored
from public.captures c
where exists(select 1 from public.capture_analyses a where a.capture_id=c.id and a.analysis_type='intent' and a.status='succeeded')
and ((not exists(select 1 from public.capture_evaluations e where e.capture_id=c.id and e.evaluator_id=c.user_id)
      and not exists(select 1 from public.capture_revisit_state s where s.capture_id=c.id and s.first_exposed_at is not null))
  or exists(select 1 from public.capture_evaluations e where e.capture_id=c.id and e.evaluator_id=c.user_id and e.rated_at is null));

-- Direct object reads/signing are refused until exposure has committed through the boundary.
drop policy if exists "owners read capture storage objects" on storage.objects;
create policy "owners read capture storage objects" on storage.objects for select to authenticated using (
 bucket_id='capture-assets' and (storage.foldername(name))[1]='captures'
 and (storage.foldername(name))[2]=(select auth.uid())::text
 and exists(select 1 from public.capture_revisit_state s where s.capture_id::text=(storage.foldername(name))[3]
   and s.user_id=(select auth.uid()) and s.first_exposed_at is not null));

revoke all on function public.revisit_expose(uuid), public.revisit_batch(), public.revisit_action(uuid,uuid,text,text), public.research_record_recall(uuid,text,text) from public, anon;
grant execute on function public.revisit_expose(uuid), public.revisit_batch(), public.revisit_action(uuid,uuid,text,text), public.research_record_recall(uuid,text,text) to authenticated;
revoke all on function public.capture_recall_exposure_guard() from public, anon, authenticated;

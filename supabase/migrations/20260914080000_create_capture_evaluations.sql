-- Evaluation of a frozen intent run, recorded without hindsight.
--
-- The recall answer must be captured before the evaluator can see what the model said, so
-- recall lives in the same row as the rating but is written first and then made immutable by
-- trigger. A rating is bound to one exact `capture_analyses` row -- never to "the capture's
-- analysis" -- so Haiku, Sonnet and later prompt versions stay comparable after the fact.

-- A rating must cite an analysis that genuinely belongs to the capture being evaluated.
-- The composite key lets a foreign key enforce that instead of a trigger.
alter table public.capture_analyses
  add constraint capture_analyses_id_capture_key unique (id, capture_id);

create table public.capture_evaluations (
  id uuid primary key default extensions.gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version >= 1),
  capture_id uuid not null references public.captures(id) on delete cascade,
  analysis_id uuid not null,
  evaluator_id uuid not null references auth.users(id) on delete cascade,

  -- Phase one: unaided recall. Written before any analysis field is revealed.
  recall_status text not null check (
    recall_status in ('remembered', 'partial', 'cannot_remember')
  ),
  remembered_interest text check (
    remembered_interest is null
    or (remembered_interest = btrim(remembered_interest) and remembered_interest <> '')
  ),
  recalled_at timestamptz not null default now(),

  -- Phase two: the rating of the revealed run.
  intent_accuracy text check (
    intent_accuracy is null or intent_accuracy in ('correct', 'close', 'wrong')
  ),
  still_interested boolean,
  consumed_before_evaluation boolean,
  notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  revealed_at timestamptz,
  rated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An evaluator who cannot remember the capture has no remembered interest to give.
  constraint capture_evaluations_recall_consistent check (
    recall_status <> 'cannot_remember' or remembered_interest is null
  ),
  -- A rating is complete or absent; a half-written rating is not evidence.
  constraint capture_evaluations_rating_complete check (
    (intent_accuracy is null and rated_at is null
      and still_interested is null and consumed_before_evaluation is null)
    or (intent_accuracy is not null and rated_at is not null
      and still_interested is not null and consumed_before_evaluation is not null)
  ),
  -- A rating can only exist after the run was revealed.
  constraint capture_evaluations_reveal_precedes_rating check (
    rated_at is null or (revealed_at is not null and rated_at >= revealed_at)
  ),
  constraint capture_evaluations_recall_precedes_reveal check (
    revealed_at is null or revealed_at >= recalled_at
  ),
  constraint capture_evaluations_analysis_fkey
    foreign key (analysis_id, capture_id)
    references public.capture_analyses(id, capture_id) on delete cascade
);

-- One evaluation per evaluator per run. This is what makes a repeated submission idempotent
-- rather than a second, contradictory data point.
create unique index capture_evaluations_run_uidx
  on public.capture_evaluations (evaluator_id, analysis_id);
create index capture_evaluations_capture_idx
  on public.capture_evaluations (evaluator_id, capture_id, created_at, id);

-- The evaluator must own the capture they are evaluating. RLS already blocks the authenticated
-- path; this closes the same hole for any privileged writer.
create or replace function public.capture_evaluations_enforce_owner()
returns trigger
language plpgsql
-- Definer so the check sees the real ownership fact rather than an RLS-filtered view of it.
-- This is a data-integrity guard; access control stays with the policies below.
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.captures
    where captures.id = new.capture_id and captures.user_id = new.evaluator_id
  ) then
    raise exception 'evaluator does not own capture %', new.capture_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger capture_evaluations_owner_before_write
  before insert or update on public.capture_evaluations
  for each row execute function public.capture_evaluations_enforce_owner();

-- Recall is the experiment's control. Once stored it is frozen: a reveal-phase update may add
-- the rating, never edit the answer given before the model output was seen.
create or replace function public.capture_evaluations_freeze_recall()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.capture_id is distinct from old.capture_id
    or new.analysis_id is distinct from old.analysis_id
    or new.evaluator_id is distinct from old.evaluator_id
    or new.recall_status is distinct from old.recall_status
    or new.remembered_interest is distinct from old.remembered_interest
    or new.recalled_at is distinct from old.recalled_at
  then
    raise exception 'unaided recall is immutable once stored'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();

  return new;
end;
$$;

create trigger capture_evaluations_freeze_recall_before_update
  before update on public.capture_evaluations
  for each row execute function public.capture_evaluations_freeze_recall();

alter table public.capture_evaluations enable row level security;

create policy "evaluators read own evaluations"
  on public.capture_evaluations for select to authenticated
  using (
    (select auth.uid()) = evaluator_id
    and exists (
      select 1 from public.captures
      where captures.id = capture_evaluations.capture_id
        and captures.user_id = (select auth.uid())
    )
  );

create policy "evaluators record own recall"
  on public.capture_evaluations for insert to authenticated
  with check (
    (select auth.uid()) = evaluator_id
    and exists (
      select 1 from public.captures
      where captures.id = capture_evaluations.capture_id
        and captures.user_id = (select auth.uid())
    )
  );

create policy "evaluators rate own evaluations"
  on public.capture_evaluations for update to authenticated
  using ((select auth.uid()) = evaluator_id)
  with check ((select auth.uid()) = evaluator_id);

revoke all on public.capture_evaluations from anon, authenticated;
grant select, insert, update on public.capture_evaluations to authenticated;

-- Selection of the next capture to evaluate. Expressed as a security-invoker view so the
-- evaluator's own row-level security still applies: the console cannot widen its reach by
-- asking a different question. The view exposes capture-time columns only — no analysis
-- result, model id or confidence can leak through it during the recall phase.
create view public.research_pending_evaluations
with (security_invoker = true) as
select
  c.id as capture_id,
  c.user_id,
  c.capture_channel,
  c.capture_kind,
  c.raw_text,
  c.user_note,
  c.source_platform,
  c.captured_at,
  exists (
    select 1 from public.capture_evaluations e
    where e.capture_id = c.id
      and e.evaluator_id = c.user_id
  ) as recall_stored
from public.captures c
where exists (
  select 1 from public.capture_analyses a
  where a.capture_id = c.id
    and a.analysis_type = 'intent'
    and a.status = 'succeeded'
)
and (
  not exists (
    select 1 from public.capture_evaluations e
    where e.capture_id = c.id
      and e.evaluator_id = c.user_id
  )
  or exists (
    select 1 from public.capture_evaluations e
    where e.capture_id = c.id
      and e.evaluator_id = c.user_id
      and e.rated_at is null
  )
);

revoke all on public.research_pending_evaluations from anon, authenticated;
grant select on public.research_pending_evaluations to authenticated;

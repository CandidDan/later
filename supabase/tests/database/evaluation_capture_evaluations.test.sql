begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

select has_table('public', 'capture_evaluations', 'capture_evaluations table exists');
select col_is_fk('public', 'capture_evaluations', 'capture_id', 'evaluations belong to captures');
select col_is_fk('public', 'capture_evaluations', 'evaluator_id', 'evaluations name their evaluator');
select has_index('public', 'capture_evaluations', 'capture_evaluations_run_uidx',
  'one evaluation per evaluator per analysis run');
select is((select relrowsecurity from pg_class where oid = 'public.capture_evaluations'::regclass), true,
  'capture_evaluations has RLS enabled');

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'evaluator@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'stranger@example.test');

insert into public.captures (id, user_id, capture_channel, captured_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'whatsapp', now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', 'whatsapp', now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '11111111-1111-1111-1111-111111111111', 'email', now());

-- Two successful runs of the same capture: a Haiku run and a Sonnet run.
insert into public.capture_analyses
  (id, capture_id, analysis_type, status, input_snapshot, result, model_id, prompt_version, pipeline_version)
values
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'intent', 'succeeded', '{}', '{"interest":"haiku"}', 'claude-haiku-4-5', 'v1', 'v1'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'intent', 'succeeded', '{}', '{"interest":"sonnet"}', 'claude-sonnet-5', 'v2', 'v1'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
    'intent', 'succeeded', '{}', '{"interest":"unrated"}', 'claude-haiku-4-5', 'v1', 'v1'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc9', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'intent', 'succeeded', '{}', '{"interest":"stranger"}', 'claude-haiku-4-5', 'v1', 'v1');

-- AC5: one recall answer, one distinct rating row per run, each bound to its own analysis id.
insert into public.capture_evaluations
  (id, capture_id, analysis_id, evaluator_id, recall_status, remembered_interest)
values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'cccccccc-cccc-cccc-cccc-ccccccccccc1', '11111111-1111-1111-1111-111111111111',
    'remembered', 'wanted the pasta recipe'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'cccccccc-cccc-cccc-cccc-ccccccccccc2', '11111111-1111-1111-1111-111111111111',
    'remembered', 'wanted the pasta recipe');

select is(
  (select count(distinct remembered_interest)::integer from public.capture_evaluations
   where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  1, 'both runs reuse the single unaided recall answer');
select is(
  (select count(distinct analysis_id)::integer from public.capture_evaluations
   where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  2, 'each run is rated against its own analysis id');

select throws_ok(
  $$insert into public.capture_evaluations (capture_id, analysis_id, evaluator_id, recall_status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
      '11111111-1111-1111-1111-111111111111', 'partial')$$,
  '23505', null, 'a repeated submission cannot duplicate an evaluation of one run');
select throws_ok(
  $$insert into public.capture_evaluations (capture_id, analysis_id, evaluator_id, recall_status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'cccccccc-cccc-cccc-cccc-ccccccccccc9',
      '11111111-1111-1111-1111-111111111111', 'partial')$$,
  '23503', null, 'a rating cannot cite an analysis from another capture');
select throws_ok(
  $$insert into public.capture_evaluations (capture_id, analysis_id, evaluator_id, recall_status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'cccccccc-cccc-cccc-cccc-ccccccccccc9',
      '11111111-1111-1111-1111-111111111111', 'partial')$$,
  '23514', null, 'an evaluator cannot evaluate a capture they do not own');
select throws_ok(
  $$insert into public.capture_evaluations (capture_id, analysis_id, evaluator_id, recall_status, remembered_interest)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', 'cccccccc-cccc-cccc-cccc-ccccccccccc3',
      '11111111-1111-1111-1111-111111111111', 'cannot_remember', 'something')$$,
  '23514', null, 'cannot-remember recall carries no remembered interest');
select throws_ok(
  $$update public.capture_evaluations set intent_accuracy = 'correct'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '23514', null, 'a half-written rating is rejected');
select throws_ok(
  $$update public.capture_evaluations
    set intent_accuracy = 'correct', still_interested = true, consumed_before_evaluation = false,
        rated_at = now()
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '23514', null, 'a rating cannot exist before the run was revealed');

-- The reveal-then-rate path succeeds and leaves recall untouched.
update public.capture_evaluations set revealed_at = now()
  where id in ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2');
select lives_ok(
  $$update public.capture_evaluations
    set intent_accuracy = 'correct', still_interested = true, consumed_before_evaluation = false,
        rated_at = now()
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  'a revealed run can be rated');
select lives_ok(
  $$update public.capture_evaluations
    set intent_accuracy = 'wrong', still_interested = false, consumed_before_evaluation = true,
        rated_at = now()
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2'$$,
  'the second run receives an independent rating');
select is(
  (select count(distinct intent_accuracy)::integer from public.capture_evaluations
   where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  2, 'the two runs are rated independently');
select is(
  (select count(*)::integer from public.capture_analyses
   where capture_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
     and result is not null and model_id in ('claude-haiku-4-5', 'claude-sonnet-5')),
  2, 'rating a run does not modify either analysis');

select throws_ok(
  $$update public.capture_evaluations set recall_status = 'cannot_remember'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '23514', null, 'unaided recall is immutable once stored');
select throws_ok(
  $$update public.capture_evaluations set remembered_interest = 'rewritten after seeing the model'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '23514', null, 'remembered interest cannot be rewritten after reveal');
select throws_ok(
  $$update public.capture_evaluations set analysis_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '23514', null, 'a rating cannot be re-pointed at a different run');

-- RLS: the owning evaluator.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select is((select count(*)::integer from public.capture_evaluations), 2,
  'an evaluator reads only their own evaluations');
select is(
  (select count(*)::integer from public.research_pending_evaluations),
  1, 'only the unevaluated capture with a successful run is offered');
select is(
  (select capture_id from public.research_pending_evaluations),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'::uuid,
  'the already-evaluated capture is not offered again');
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'research_pending_evaluations'
     and column_name in ('result', 'model_id', 'confidence', 'prompt_version', 'input_snapshot')),
  0, 'the recall-phase view exposes no analysis column');
select lives_ok(
  $$update public.capture_evaluations set notes = 'still relevant'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  'an evaluator can annotate their own evaluation');
select throws_ok(
  $$delete from public.capture_evaluations where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  '42501', null, 'evaluations cannot be deleted by the evaluator');
select throws_ok(
  $$update public.capture_analyses set result = '{"interest":"edited"}'
    where id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'$$,
  '42501', null, 'analyses stay immutable to the evaluator');

-- RLS: a signed-in stranger.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select is((select count(*)::integer from public.capture_evaluations), 0,
  'another user cannot see an evaluation they did not write');
select lives_ok(
  $$update public.capture_evaluations set notes = 'tampered'
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'$$,
  'a cross-user update matches no rows without exposing them');
select throws_ok(
  $$insert into public.capture_evaluations (capture_id, analysis_id, evaluator_id, recall_status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
      '11111111-1111-1111-1111-111111111111', 'partial')$$,
  '42501', null, 'a user cannot write an evaluation as somebody else');

set local role anon;
select throws_ok(
  $$select count(*) from public.capture_evaluations$$,
  '42501', null, 'unsigned public requests have no evaluation privilege');

reset role;
select is((select notes from public.capture_evaluations where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'),
  'still relevant', 'the cross-user update changed nothing');
select is((select count(*)::integer from pg_policies where schemaname = 'public'
  and tablename = 'capture_evaluations' and cmd = 'DELETE'), 0,
  'evaluations have no delete policy');
select is((select count(*)::integer from pg_policies where schemaname = 'public'
  and tablename = 'capture_analyses' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 0,
  'analyses still have no authenticated mutation policy');

select * from finish();
rollback;

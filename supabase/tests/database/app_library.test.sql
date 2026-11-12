begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select has_function('public', 'app_library_page', array['timestamp with time zone','uuid','integer'],
  'library page RPC exists');
select ok(has_function_privilege('authenticated', 'public.app_library_page(timestamptz,uuid,int)', 'execute'),
  'authenticated callers may request library pages');
select ok(not has_function_privilege('anon', 'public.app_library_page(timestamptz,uuid,int)', 'execute'),
  'anonymous callers cannot request library pages');
select ok(not has_function_privilege('service_role', 'public.app_library_page(timestamptz,uuid,int)', 'execute'),
  'only the authenticated application role receives execution');

insert into auth.users(id,email) values
  ('26262626-0000-4000-8000-000000000001','library-owner@example.test'),
  ('26262626-0000-4000-8000-000000000002','library-other@example.test');
-- Repeated timestamps exercise the id tie-breaker across page boundaries.
insert into public.captures(id,user_id,capture_channel,captured_at)
select ('26262626-aaaa-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  '26262626-0000-4000-8000-000000000001','email',
  '2026-01-01'::timestamptz + (i/3)*interval '1 day'
from generate_series(1,120) i;
insert into public.captures(id,user_id,capture_channel,captured_at) values
  ('26262626-bbbb-4000-8000-000000000001','26262626-0000-4000-8000-000000000002','email','2027-01-01');
insert into public.capture_revisit_state(capture_id,user_id,consumed_at,deferred_until) values
  ('26262626-aaaa-4000-8000-000000000060','26262626-0000-4000-8000-000000000001',now(),null),
  ('26262626-aaaa-4000-8000-000000000119','26262626-0000-4000-8000-000000000001',null,now()+interval '7 days');
insert into public.capture_analyses(id,capture_id,analysis_type,status,input_snapshot,result,model_id,prompt_version,pipeline_version)
select ('26262626-cccc-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  ('26262626-aaaa-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  'intent','succeeded','{}','{"interest":"frozen"}','model','v1','v1'
from generate_series(119,120) i;

-- An error on the second release must roll back exposure of the first row too.
create function public.test_library_exposure_failure() returns trigger language plpgsql as $$
begin
  if new.capture_id = '26262626-aaaa-4000-8000-000000000119' then
    raise exception 'Simulated exposure failure';
  end if;
  return new;
end $$;
create trigger test_library_exposure_failure before insert or update on public.capture_revisit_state
  for each row execute function public.test_library_exposure_failure();
set local role authenticated;
select set_config('request.jwt.claim.sub','26262626-0000-4000-8000-000000000001',true);
select throws_ok('select * from app_library_page(null,null,50)', 'P0001', 'Simulated exposure failure',
  'AC1 exposure failure aborts the whole page');
select is((select count(*)::int from capture_revisit_state where first_exposed_at is not null),0,
  'AC1 failed page rolls back all earlier exposure writes');
reset role;
drop trigger test_library_exposure_failure on public.capture_revisit_state;
drop function public.test_library_exposure_failure();

set local role authenticated;
select set_config('request.jwt.claim.sub','26262626-0000-4000-8000-000000000001',true);
select is(research_record_recall('26262626-aaaa-4000-8000-000000000119','remembered','original')->>'runs','1',
  'AC2 recall recorded before the library request succeeds');
create temp table page_one as select * from app_library_page(null,null,50) with ordinality;
select is((select count(*)::int from page_one),50,'AC7 first page contains 50 rows');
select ok((select bool_and(has_more) from page_one),'AC7 first page signals a next cursor');
select is((select count(*)::int from capture_revisit_state where first_exposed_at is not null),50,
  'AC1 exactly the returned rows are exposed in the page transaction');
select ok(not exists(select 1 from page_one p left join capture_revisit_state s using(capture_id)
  where s.first_exposed_at is null),'AC1 every returned row is exposed');
select ok(not exists(select 1 from capture_revisit_state s where first_exposed_at is not null
  and not exists(select 1 from page_one p where p.capture_id=s.capture_id)),
  'AC1 lookahead and all unreturned rows remain unexposed');
select ok(exists(select 1 from page_one where capture_id='26262626-aaaa-4000-8000-000000000119'),
  'AC7 future-deferred captures remain in the library');
select results_eq('select capture_id from page_one order by ordinality',
  $$select id from captures where id <> '26262626-aaaa-4000-8000-000000000060'
    order by captured_at desc,id desc limit 50$$,'AC7 page is newest first with descending id ties');
select ok(not exists(select 1 from research_pending_evaluations where capture_id='26262626-aaaa-4000-8000-000000000120'),
  'AC2 exposed capture with no recall is removed from research selection');
select is(research_record_recall('26262626-aaaa-4000-8000-000000000120','remembered','fresh')->>'status','exposed',
  'AC2 fresh recall is refused after library exposure');
select throws_ok($$insert into capture_evaluations(capture_id,analysis_id,evaluator_id,recall_status,remembered_interest)
  values('26262626-aaaa-4000-8000-000000000120','26262626-cccc-4000-8000-000000000120',
    '26262626-0000-4000-8000-000000000001','remembered','bypass')$$,
  '23514','Capture already exposed','AC2 direct inserts cannot bypass the recall guard');
select ok(exists(select 1 from research_pending_evaluations where capture_id='26262626-aaaa-4000-8000-000000000119' and recall_stored),
  'AC2 earlier recall remains eligible for rating after library exposure');
select lives_ok($$update capture_evaluations set intent_accuracy='correct',still_interested=true,
  consumed_before_evaluation=false,revealed_at=clock_timestamp(),rated_at=clock_timestamp()
  where capture_id='26262626-aaaa-4000-8000-000000000119'$$,
  'AC2 prior unaided recall can still be rated');
select is((select remembered_interest from capture_evaluations
  where capture_id='26262626-aaaa-4000-8000-000000000119'),'original',
  'AC2 rating preserves original unaided recall');
select ok((select rated_at is not null from capture_evaluations
  where capture_id='26262626-aaaa-4000-8000-000000000119'),'AC2 rating is persisted');

create temp table page_two as select p.* from
  (select captured_at,capture_id from page_one order by ordinality desc limit 1) cursor
  cross join lateral app_library_page(cursor.captured_at,cursor.capture_id,50) with ordinality p;
create temp table page_three as select p.* from
  (select captured_at,capture_id from page_two order by ordinality desc limit 1) cursor
  cross join lateral app_library_page(cursor.captured_at,cursor.capture_id,50) with ordinality p;
select is((select count(*)::int from page_two),50,'AC7 second page contains 50 rows');
select is((select count(*)::int from page_three),19,'AC7 final page contains remaining unconsumed rows');
select ok((select bool_and(has_more) from page_two),'AC7 second page signals a next cursor');
select ok((select bool_and(not has_more) from page_three),'AC7 final page signals null next cursor');
select ok((select count(*) = 19 and bool_and(not has_more) from app_library_page(
  (select captured_at from page_two order by ordinality desc limit 1),
  (select capture_id from page_two order by ordinality desc limit 1),19)),
  'AC7 exactly full final page still signals null next cursor');
create temp table all_pages as
  select 1 as page,* from page_one union all select 2,* from page_two union all select 3,* from page_three;
select is((select count(distinct capture_id)::int from all_pages),119,'AC7 all pages are disjoint');
select results_eq('select capture_id from all_pages order by page,ordinality',
  $$select id from captures where id <> '26262626-aaaa-4000-8000-000000000060'
    order by captured_at desc,id desc$$,'AC7 120 owned captures page in order with consumed capture excluded');
select is((select count(*)::int from capture_revisit_state where first_exposed_at is not null),119,
  'AC1 paging exposes exactly the 119 released captures');
select ok((select first_exposed_at is null from capture_revisit_state
  where capture_id='26262626-aaaa-4000-8000-000000000060'),'AC7 consumed item stays unexposed');
select is((select count(*)::int from app_library_page(
  (select captured_at from page_three order by ordinality desc limit 1),
  (select capture_id from page_three order by ordinality desc limit 1),50)),0,
  'AC7 cursor after final page returns no rows');
create temp table original_exposures as select capture_id,first_exposed_at from capture_revisit_state;
select is((select count(*)::int from app_library_page(null,null,0)),1,'limit zero clamps to one');
select is((select count(*)::int from app_library_page(null,null,-20)),1,'negative limit clamps to one');
select is((select count(*)::int from app_library_page(null,null,500)),50,'large limit clamps to fifty');
select is((select count(*)::int from app_library_page(null,null,null)),50,'null limit defaults to fifty');
select results_eq('select capture_id,first_exposed_at from capture_revisit_state order by capture_id',
  'select capture_id,first_exposed_at from original_exposures order by capture_id',
  'repeated pages preserve original exposure timestamps');
select throws_ok($$select * from app_library_page(now(),null,50)$$,'22023','Incomplete library cursor',
  'timestamp-only cursor is rejected');
select throws_ok($$select * from app_library_page(null,'26262626-aaaa-4000-8000-000000000001',50)$$,
  '22023','Incomplete library cursor','id-only cursor is rejected');
select ok(not revisit_expose('26262626-bbbb-4000-8000-000000000001'),
  'AC3 narration exposure refuses another owner capture');
reset role;
select is((select count(*)::int from capture_revisit_state
  where capture_id='26262626-bbbb-4000-8000-000000000001'),0,
  'AC3 foreign capture remains unexposed after all owner requests');
set local role authenticated;
select set_config('request.jwt.claim.sub','26262626-0000-4000-8000-000000000002',true);
select results_eq('select capture_id,has_more from app_library_page(null,null,50)',
  $$values('26262626-bbbb-4000-8000-000000000001'::uuid,false)$$,
  'AC3 other owner library returns only their capture');
select is((select count(*)::int from capture_revisit_state where first_exposed_at is not null),1,
  'AC3 other owner sees only their own exposure');
select set_config('request.jwt.claim.sub','',true);
select is((select count(*)::int from app_library_page(null,null,50)),0,
  'missing auth identity releases no rows even with authenticated role');
reset role;
set local role anon;
select throws_ok('select * from app_library_page(null,null,50)','42501',null,
  'anonymous page invocation is denied');
reset role;
select * from finish();
rollback;

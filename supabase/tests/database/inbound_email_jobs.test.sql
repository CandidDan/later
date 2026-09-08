begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
insert into auth.users(id,email) values ('88888888-8888-8888-8888-888888888888','email-owner@example.test');

-- AC2: one signed event commits one capture, one initial intent job and one enrichment job.
create temp table saved as select * from persist_capture_with_intent_job(
 '88888888-8888-8888-8888-888888888888','email','resend-email-1','email','Worth reading',null,null,now(),
 '{"provider":"resend","emailId":"resend-email-1","urls":["https://example.com/article"]}',
 '[{"role":"email_representation","fileName":"email.json","contentType":"application/json"},
   {"role":"email_attachment","id":"att-1","fileName":"brief.pdf","contentType":"application/pdf"},
   {"role":"email_attachment","id":"att-2","fileName":"cover.png","contentType":"image/png"}]');
select is((select count(*)::int from captures where external_message_id='resend-email-1'),1,'AC2 one email is one capture');
select is((select capture_kind from captures where external_message_id='resend-email-1'),'email','AC2 the capture kind states email explicitly');
select is((select count(*)::int from capture_assets where capture_id=(select capture_id from saved)),3,'AC2 the representation and every attachment get a durable home');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved) and job_type='email_enrichment' and status='pending'),1,'AC2 exactly one enrichment job is queued');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved) and job_type='intent_analysis'),1,'AC2 exactly one initial intent job is queued');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved) and job_type='media_download'),0,'AC2 email attachments do not enter the WhatsApp media queue');
select ok((select raw_payload ? 'event' from captures where external_message_id='resend-email-1'),'AC2 the signed event payload is retained');

-- AC4: a replayed delivery of the same email id changes nothing.
select lives_ok($$select * from persist_capture_with_intent_job('88888888-8888-8888-8888-888888888888','email','resend-email-1','email','Worth reading',null,null,now(),'{"provider":"resend","deliveryId":"second"}','[{"role":"email_representation","fileName":"email.json"}]')$$,'AC4 a replayed delivery succeeds');
select is((select count(*)::int from captures where external_message_id='resend-email-1'),1,'AC4 replay keeps exactly one capture');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved) and job_type='intent_analysis'),1,'AC4 replay keeps exactly one initial intent job');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved) and job_type='email_enrichment'),1,'AC4 replay keeps exactly one enrichment job');
select is((select count(*)::int from capture_assets where capture_id=(select capture_id from saved)),3,'AC4 replay does not duplicate assets');
select throws_ok($$insert into capture_jobs(capture_id,job_type) select capture_id,'email_enrichment' from saved$$,'23505',null,'AC4 a second enrichment job cannot be inserted');

-- The initial metadata-only run happens first and is never rewritten.
create temp table initial_job as select * from claim_intent_job('intent_analysis');
select * from finish_intent_attempt((select id from initial_job),1,jsonb_build_object('captureId',(select capture_id from saved),'status','succeeded','inputSnapshot','{"channel":"email"}'::jsonb,'result','{"resolutionRequired":false}'::jsonb,'confidence',0.4,'modelId','test','promptVersion','test','pipelineVersion','initial'));
create temp table original_run as select * from capture_analyses;
select is((select count(*)::int from capture_jobs where intent_phase='enriched'),0,'AC7 no enriched run is scheduled while the email is still pending');

-- Leases are exclusive and attempt-fenced, exactly like the other queues.
create temp table e1 as select * from claim_email_enrichment_job();
select is((select count(*)::int from claim_email_enrichment_job()),0,'an active lease is not reclaimable');
select ok(not finish_email_asset((select id from e1),2,(select id from capture_assets where capture_id=(select capture_id from saved) order by created_at limit 1),'{}'),'AC6 a stale attempt cannot finalize an asset');
select ok(not finish_email_enrichment_attempt((select id from e1),2),'AC6 a stale attempt cannot finalize the job');

-- AC5: the representation and each attachment reach terminal stored state with their evidence.
select ok(finish_email_asset((select id from e1),1,(select id from capture_assets where capture_id=(select capture_id from saved) and filename='email.json'),'{"mediaType":"application/json","byteSize":512,"sha256":"1111111111111111111111111111111111111111111111111111111111111111"}'),'AC5 the parsed representation is recorded as stored');
select is((select storage_state from capture_assets where filename='email.json'),'stored','AC5 the representation asset is terminal stored');
select is((select stored_byte_size from capture_assets where filename='email.json'),512::bigint,'AC5 observed size is recorded');
select ok((select metadata->>'role'='email_representation' from capture_assets where filename='email.json'),'AC5 original capture-time metadata survives enrichment');
select ok(finish_email_asset((select id from e1),1,(select id from capture_assets where filename='brief.pdf'),'{"mediaType":"application/pdf","byteSize":13264,"sha256":"2222222222222222222222222222222222222222222222222222222222222222"}'),'AC5 an attachment is recorded as stored');
select ok((select metadata->>'id'='att-1' and not (metadata ? 'url') and not (metadata ? 'download_url') from capture_assets where filename='brief.pdf'),'AC5 no provider download URL is stored as durable content');

-- AC6: an unsafe attachment is terminal for that asset only.
select ok(finish_email_asset((select id from e1),1,(select id from capture_assets where filename='cover.png'),null,'unsafe_media'),'AC6 an unsafe attachment fails terminally');
select is((select storage_state from capture_assets where filename='cover.png'),'failed','AC6 the failed attachment is terminal');
select is((select storage_error from capture_assets where filename='cover.png'),'unsafe_media','AC6 a safe code is visible on the asset');
select is((select storage_state from capture_assets where filename='brief.pdf'),'stored','AC6 one failed attachment does not undo a stored one');
select is((select count(*)::int from captures where external_message_id='resend-email-1'),1,'AC6 failure never loses the capture');

select ok(finish_email_enrichment_attempt((select id from e1),1),'AC5 the enrichment attempt completes');
select is((select status from capture_jobs where id=(select id from e1)),'completed','AC5 the enrichment job is terminal completed');

-- AC7: exactly one enriched run is scheduled, once, and it appends.
select is((select count(*)::int from capture_jobs where intent_phase='enriched'),1,'AC7 exactly one enriched intent job is scheduled');
select enqueue_media_enrichment((select capture_id from saved));
select is((select count(*)::int from capture_jobs where intent_phase='enriched'),1,'AC7 repeated scheduling cannot duplicate the enriched run');
create temp table enrichment as select * from claim_intent_job('intent_analysis');
select * from finish_intent_attempt((select id from enrichment),1,jsonb_build_object('captureId',(select capture_id from saved),'status','succeeded','inputSnapshot','{"analysisPhase":"enriched","email":{"assetId":"a","sha256":"b"}}'::jsonb,'result','{}'::jsonb,'confidence',0.8,'modelId','test','promptVersion','test','pipelineVersion','email'));
select is((select count(*)::int from capture_analyses),2,'AC7 enrichment appends exactly one new run');
select is((select row_to_json(a)::text from capture_analyses a where a.id=(select id from original_run)),(select row_to_json(o)::text from original_run o),'AC7 the earlier analysis remains byte-for-byte unchanged');
select is((select raw_text from captures where external_message_id='resend-email-1'),'Worth reading','AC7 the capture itself is never rewritten');

-- AC6: a transient retrieval failure retries, and an exhausted one fails safely with every
-- still-pending asset made terminal rather than left looking like it is still coming.
create temp table saved2 as select * from persist_capture_with_intent_job(
 '88888888-8888-8888-8888-888888888888','email','resend-email-2','email','Second',null,null,now(),'{}',
 '[{"role":"email_representation","fileName":"email.json"},{"role":"email_attachment","id":"att-9","fileName":"late.pdf"}]');
create temp table i2 as select * from claim_intent_job('intent_analysis');
select * from finish_intent_attempt((select id from i2),1,jsonb_build_object('captureId',(select capture_id from saved2),'status','succeeded','inputSnapshot','{}'::jsonb,'result','{}'::jsonb,'confidence',0.4,'modelId','test','promptVersion','test','pipelineVersion','initial'));
create temp table r1 as select * from claim_email_enrichment_job();
select ok(finish_email_enrichment_attempt((select id from r1),1,'a provider message quoting the private email body'),'AC6 an arbitrary failure reason is accepted but sanitized');
select is((select last_error from capture_jobs where id=(select id from r1)),'email_unavailable','AC6 provider-controlled text never reaches the error column');
select is((select status from capture_jobs where id=(select id from r1)),'pending','AC6 a transient failure is retried, not abandoned');
select is((select count(*)::int from capture_jobs where capture_id=(select capture_id from saved2) and intent_phase='enriched'),0,'AC6 no enriched run is scheduled while a retry is outstanding');
update capture_jobs set available_at=now()-interval '1 minute' where id=(select id from r1);
create temp table r2 as select * from claim_email_enrichment_job();
select ok(finish_email_enrichment_attempt((select id from r2),2,'email_missing'),'AC6 a terminal code is accepted');
select is((select status from capture_jobs where id=(select id from r2)),'failed','AC6 a terminal code is not retried');
select is((select count(*)::int from capture_assets where capture_id=(select capture_id from saved2) and storage_state='pending'),0,'AC6 an exhausted job leaves no asset looking pending');
select is((select storage_error from capture_assets where capture_id=(select capture_id from saved2) and filename='late.pdf'),'email_missing','AC6 safe failure state is visible on the assets');
select is((select count(*)::int from capture_analyses where capture_id=(select capture_id from saved2)),1,'AC6 the successful initial run survives the failure');
select is((select count(*)::int from captures where external_message_id='resend-email-2'),1,'AC6 the initial capture survives the failure');

-- Attempts are bounded exactly as the other queues are.
create temp table saved3 as select * from persist_capture_with_intent_job(
 '88888888-8888-8888-8888-888888888888','email','resend-email-3','email','Third',null,null,now(),'{}',
 '[{"role":"email_representation","fileName":"email.json"}]');
update capture_jobs set attempts=3 where capture_id=(select capture_id from saved3) and job_type='email_enrichment';
select is((select count(*)::int from claim_email_enrichment_job()),0,'AC6 an exhausted job is not claimed again');
select is((select status from capture_jobs where capture_id=(select capture_id from saved3) and job_type='email_enrichment'),'failed','AC6 an exhausted job is swept to failed');
select is((select last_error from capture_jobs where capture_id=(select capture_id from saved3) and job_type='email_enrichment'),'attempts_exhausted','AC6 exhaustion is recorded as its own safe code');

-- Privilege boundary: the queue is service-role only.
select ok(not has_function_privilege('anon','claim_email_enrichment_job()','execute'),'anonymous callers cannot claim email work');
select ok(not has_function_privilege('authenticated','finish_email_asset(uuid,integer,uuid,jsonb,text)','execute'),'signed-in users cannot finalize email assets');
select ok(has_function_privilege('service_role','finish_email_enrichment_attempt(uuid,integer,text)','execute'),'the worker role can finalize an attempt');

select * from finish();
rollback;

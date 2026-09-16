# Later v0 production launch runbook

Later is the private capture-and-intent experiment at `notfor.now`. The v0 production shape
accepts WhatsApp text and media plus inbound email, stores the original evidence in Supabase,
runs five durable background queues, and exposes a private recall-before-reveal research console.

This is the source of truth for launch, smoke testing, pause, rollback and recovery. It is written
for one human operator. A green local check proves that configuration is structurally complete;
it does not prove that provider credentials, DNS or production connectivity work.

## Automatic intent processing

The production processor now rotates across all five v0 queues rather than serving intent alone.
The sections below replace the earlier intent-only operator guide while retaining its safe dispatch,
retry and recovery contract.

## Safety boundaries

- Never put a credential in source control, SQL text, a command argument, a diagnostic query or
  captured command output. Enter secrets through the Vercel, Supabase, Twilio and Resend dashboards
  or an approved secret-manager integration. Keep shell tracing disabled when loading local env.
- Never select or print `raw_text`, `raw_payload`, `input_snapshot`, `result`, object contents,
  request headers, Vault decrypted values or provider response bodies during launch diagnostics.
- Do not reset attempts, reuse a live lease, delete a failed job, mutate an analysis or overwrite a
  stored asset to make a smoke test pass. Failed jobs and immutable analyses are experiment evidence.
- The worker and automated tests do not deploy, alter DNS, call live providers, run production
  migrations or enter secrets. Those are the human-operated steps below.

## 1. Prepare the operator workstation

1. Use a clean checkout of the approved commit. Install the pinned package manager and dependencies
   with `pnpm install --frozen-lockfile`; run `pnpm build`, `pnpm lint`, `pnpm test` and
   `pnpm test:coverage` before preparing production.
2. Copy `.env.example` to an ignored, permission-restricted local file such as
   `.env.production.local`. Populate it from the provider dashboards or secret manager. Do not add
   it to Git and do not paste it into an issue, PR or terminal command.
3. Load that file into the current shell with tracing disabled, then run the offline check. It prints
   only variable names and capability states and makes no network requests.

```bash
set +x
set -a
. ./.env.production.local
set +a
pnpm launch:check
```

Stop if the command exits non-zero. Correct the named variables without printing their values. A
successful result must mark WhatsApp capture, media retrieval, inbound email, intent processing,
source processing, segment processing, scheduled job dispatch and the private research console as
ready.

## 2. Create and migrate the production Supabase project

1. Create the production Supabase project in the dashboard. In Auth, create the single experiment
   user and record its UUID in the secret manager. Use that UUID for `TWILIO_CAPTURE_USER_ID`,
   `EMAIL_CAPTURE_USER_ID` and `RESEARCH_USER_ID` unless the approved experiment plan separates
   those identities.
2. Link the checkout interactively with `supabase link --project-ref "$SUPABASE_PROJECT_REF"`.
   Authenticate through the CLI's secure interactive flow; never provide a database password as an
   argument. Review the target project, then apply the entire versioned chain with `supabase db push`:

   - `20260902144000_create_capture_schema.sql`
   - `20260903013000_persist_capture_atomically.sql`
   - `20260907030000_schedule_intent_processing.sql`
   - `20260907130000_capture_media_jobs.sql`
   - `20260908090000_inbound_email_jobs.sql`
   - `20260914080000_create_capture_evaluations.sql`
   - `20260915010000_source_resolution.sql`
   - `20260915150000_segment_resolution.sql`

3. Confirm in the dashboard that the `capture-assets` bucket remains private, RLS is enabled, and
   the extensions `pg_cron`, `pg_net`, `pgcrypto` and Vault are installed. Do not weaken policies for
   smoke testing.
4. In the Supabase Vault interface in the dashboard, create `later_jobs_process_url` with the exact value
   `https://notfor.now/api/jobs/process`, and `later_jobs_process_secret` with the same secret later
   entered as Vercel's `JOBS_PROCESS_SECRET`. Use the Vault UI, not SQL. Restrict the `vault` and
   `net` schemas to trusted database operators.
5. The migration creates the named `later-intent-processing` cron job. Keep it paused until the
   deployment and channel setup are complete:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'later-intent-processing'),
  active := false
);
```

## 3. Configure and deploy Vercel for `notfor.now`

1. Import this repository into the production Vercel project. Configure every server-only and
   browser-safe value from the contract below in the Production environment. Secret values go
   through Vercel's encrypted environment UI; do not use a CLI `KEY=value` argument.
2. Confirm that only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are browser-safe.
   In particular, `SUPABASE_SERVICE_ROLE_KEY`, provider keys and webhook secrets must never have a
   `NEXT_PUBLIC_` prefix.
3. Build the approved commit, inspect its build result, and deploy it. Add `notfor.now` to the Vercel
   project, then make the required DNS change at the registrar. Wait for Vercel to show the domain
   and TLS certificate as valid before configuring signed webhooks.
4. Re-run `pnpm launch:check` against the exact values entered in Vercel. This is still an offline
   structural check; provider dashboards and the smoke matrix supply the live evidence.

## 4. Connect Twilio WhatsApp

1. In Twilio, configure the production WhatsApp sender's incoming-message webhook as
   `POST https://notfor.now/api/inbound/whatsapp`.
2. Put the exact same URL in `TWILIO_WEBHOOK_URL`. Twilio signatures include the public URL, so a
   preview URL, redirect or mismatched host fails closed with HTTP 403.
3. Put the account SID and auth token in the Vercel server environment. The token verifies webhook
   signatures and authenticates only approved media downloads; credentials are never forwarded to
   Twilio's signed CDN redirects.

## 5. Connect Resend inbound email

1. Enable Resend Receiving for the production domain. Choose a high-entropy local-part token and
   configure it as `EMAIL_INBOUND_TOKEN`; mail is captured only when a recipient local part, before
   any `+tag`, matches it.
2. Add the `email.received` webhook `POST https://notfor.now/api/inbound/email`. Enter the Standard
   Webhooks signing secret as `RESEND_WEBHOOK_SECRET` and the API key used for background retrieval
   as `RESEND_API_KEY` in Vercel.
3. The public webhook verifies the raw signed body and only acknowledges durable capture. Parsed
   email and attachments are retrieved later by `email_enrichment`; a failed retrieval preserves
   the initial event and asset records.

## 6. Production environment contract

Every key declared by `.env.example` appears here. “Absent / invalid” describes the safe runtime
behavior; the readiness command is stricter and refuses launch when any required v0 capability is
not structurally configured.

| Variable | Configuration surface | Sensitivity | Capability | Safe absent / invalid behavior |
| --- | --- | --- | --- | --- |
| `SUPABASE_URL` | Vercel server environment | Server-only | Capture persistence and all workers | Server persistence and workers fail closed |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel server environment | Secret | Capture persistence and all workers | Server persistence and workers fail closed |
| `TWILIO_AUTH_TOKEN` | Vercel server environment | Secret | WhatsApp capture and media retrieval | Webhook rejects; media retrieval is unavailable |
| `TWILIO_WEBHOOK_URL` | Vercel server environment | Server-only | WhatsApp capture | Signature verification fails closed |
| `TWILIO_CAPTURE_USER_ID` | Vercel server environment | Server-only identifier | WhatsApp capture | Webhook cannot assign an owner and fails closed |
| `ANTHROPIC_API_KEY` | Vercel server environment | Secret | Intent, source and segment processing | Model-backed jobs fail without publishing an analysis |
| `ANTHROPIC_INTENT_MODEL` | Vercel server environment | Server-only | Intent processing | Intent jobs fail closed |
| `ANTHROPIC_RESOLUTION_MODEL` | Vercel server environment | Server-only | Source processing | Source-resolution jobs fail closed |
| `ANTHROPIC_SEGMENT_MODEL` | Vercel server environment | Server-only | Segment processing | Segment-resolution jobs fail closed |
| `SEGMENT_SOURCE_MAX_BYTES` | Vercel server environment | Server-only | Segment processing | Missing defaults to 131072 bytes; invalid values fail the job |
| `JOBS_PROCESS_SECRET` | Vercel server environment plus matching Supabase Vault entry | Secret | Scheduled job dispatch | Empty disables the endpoint with HTTP 503; mismatch returns 401 |
| `TWILIO_ACCOUNT_SID` | Vercel server environment | Server-only identifier | Media retrieval | Media jobs fail closed without a download |
| `CAPTURE_MEDIA_MAX_BYTES` | Vercel server environment | Server-only | Media retrieval | Missing defaults to 5242880 bytes; invalid values fail the job |
| `RESEND_WEBHOOK_SECRET` | Vercel server environment | Secret | Inbound email | Email webhook rejects requests |
| `EMAIL_INBOUND_TOKEN` | Vercel server environment plus Resend inbound address | Secret routing token | Inbound email | Signed mail is acknowledged but not captured |
| `EMAIL_CAPTURE_USER_ID` | Vercel server environment | Server-only identifier | Inbound email | Webhook cannot assign an owner and fails closed |
| `RESEND_API_KEY` | Vercel server environment | Secret | Email enrichment | Enrichment is unavailable; initial capture evidence remains |
| `RESEND_API_BASE_URL` | Vercel server environment | Server-only | Email enrichment | Missing defaults to `https://api.resend.com`; invalid values fail enrichment |
| `EMAIL_MAX_BYTES` | Vercel server environment | Server-only | Email enrichment | Missing defaults to 5242880 bytes; invalid values fail enrichment |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel browser environment | Browser-safe | Private research console | Research authentication fails closed |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel browser environment | Browser-safe public key | Private research console | Research authentication fails closed |
| `RESEARCH_USER_ID` | Vercel server environment plus Supabase Auth user | Server-only identifier | Private research console | Console denies every evaluator |

Production endpoints are deliberately narrow:

| Endpoint | Purpose and safe failure |
| --- | --- |
| `POST /api/inbound/whatsapp` | Validates Twilio signature, persists, then returns `Saved for Later ✓`; invalid signatures are rejected |
| `POST /api/inbound/email` | Validates Resend signature, persists addressed mail, then returns `Accepted`; unaddressed signed mail receives the same acknowledgement |
| `POST /api/jobs/process` | Requires bearer `JOBS_PROCESS_SECRET`; responds only with claimed/succeeded/failed counts |
| `GET /api/research/next` | Authenticated evaluator receives capture-time recall material only |
| `POST /api/research/recall` | Stores immutable unaided recall before reveal |
| `GET /api/research/reveal` | Reveals an analysis only after recall exists |
| `POST /api/research/rating` | Stores one idempotent rating for the exact analysis run |
| `GET /research` | Private console shell; no capture or analysis data is server-rendered into the page |

The background route rotates fairly across all five current queues:
`intent_analysis`, `media_download`, `email_enrichment`, `source_resolution` and
`segment_resolution`. A single `POST /api/jobs/process` processes at most **two jobs**. The route
has a 300-second execution budget, responses contain only counts, and absent optional email
configuration makes that queue appear idle without blocking the others.

## 7. Enable dispatch

1. Verify the Vault names, schedule and recent dispatch metadata with the safe queries below. These
   select names, identifiers, statuses, counts and timestamps only.
2. Activate the named schedule only after Vercel, DNS, Twilio and Resend setup are complete.

```sql
select name from vault.secrets
where name in ('later_jobs_process_url', 'later_jobs_process_secret')
order by name;

select jobid, jobname, schedule, active from cron.job
where jobname = 'later-intent-processing';

select cron.alter_job(
  (select jobid from cron.job where jobname = 'later-intent-processing'),
  active := true
);
```

Never query `vault.decrypted_secrets`, `net.http_request_queue` headers or response bodies. A cron
success means its SQL ran; it does not prove that HTTP dispatch or a provider job succeeded.

## 8. Post-deploy smoke matrix

Use unique test messages and record only the returned acknowledgement, safe IDs, counts, statuses
and timestamps. Do not copy captured content or analysis results into the launch record.

| Path | Immediate acknowledgement | Durable capture / job / analysis check | Recall-before-reveal check | Bounded failure diagnostic |
| --- | --- | --- | --- | --- |
| WhatsApp text | Twilio delivery receives HTTP 200 with `Saved for Later ✓` | One `whatsapp` capture ID; its initial `intent_analysis` reaches `completed`; intent analysis count becomes 1 | `/research` requires recall submission before reveal, then accepts one rating | Check webhook status code, then the capture and job status queries below |
| WhatsApp media | HTTP 200 with `Saved for Later ✓` before retrieval | Capture ID has asset IDs; each `media_download` becomes `completed` with `storage_state = 'stored'`; enriched intent is appended | Recall precedes reveal for the same capture; do not inspect the asset or analysis in SQL | Check asset storage state and media job statuses; preserve any failed rows |
| Inbound email with attachment | Resend webhook receives HTTP 200 with `Accepted` | One `email` capture ID; `email_enrichment` completes; representation and attachment asset IDs are stored; enriched intent is appended | Recall precedes reveal for the email capture, then rating is durable | Check webhook status, enrichment job and asset states; never fetch provider content for diagnosis |
| Background intent processing | Authenticated dispatch returns only claimed/succeeded/failed counts | `intent_analysis` moves through pending/processing to completed and appends one immutable intent analysis | Successful intent makes the capture eligible in `/research` without revealing the result | Check the named cron run, bounded HTTP status metadata and job status |
| Background source processing | Dispatch count response contains no analysis data | A required `source_resolution` job completes and appends an immutable source-resolution analysis | Research outcome remains tied to the exact intent run | Check only job ID/status/timestamps and analysis ID/type/status |
| Background segment processing | Dispatch count response contains no fetched material | An eligible `segment_resolution` job completes and appends an immutable segment-resolution analysis | Research keeps intent, source and segment outcomes independent | Check only job ID/status/timestamps and analysis ID/type/status |
| Private `/research` console | Unauthenticated or wrong-user API calls are denied; the authorized user sees one recall prompt | Recall row exists before `revealed_at`; rating later records `rated_at` for the same analysis ID | Capture-time context appears first, recall is submitted, and only then is analysis revealed | Check evaluation ID, analysis ID and recall/reveal/rating timestamps; never select remembered text or notes |

Safe smoke queries (replace the UUID placeholder through the SQL editor's parameter facility, not
by pasting captured content):

```sql
select id, capture_channel, capture_kind, captured_at, created_at
from public.captures
order by created_at desc limit 10;

select id, capture_id, job_type, status, attempts, available_at, locked_at, completed_at, created_at
from public.capture_jobs
order by created_at desc limit 25;

select id, capture_id, storage_state, created_at, stored_at
from public.capture_assets
order by created_at desc limit 25;

select id, capture_id, analysis_type, status, created_at
from public.capture_analyses
order by created_at desc limit 25;

select id, capture_id, analysis_id, recalled_at, revealed_at, rated_at
from public.capture_evaluations
order by created_at desc limit 10;

select status, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'later-intent-processing')
order by start_time desc limit 10;

select id, status_code, timed_out, created
from net._http_response
order by created desc limit 10;
```

Stop a smoke path after one bounded diagnostic pass. A 401 means the dispatch secret differs; 403
on WhatsApp or email means signature configuration is wrong; 503 means processing is disabled; 500
means inspect the corresponding job/status metadata and deployment logs without increasing logging
to include headers, bodies, captured content or secrets.

## 9. Pause, rollback and recover

### Pause

1. Pause `later-intent-processing` with `cron.alter_job(..., active := false)` as shown above. This
   stops automatic dispatch but does not cancel an already leased job.
2. Disable the Twilio and Resend webhooks in their dashboards if new captures must stop. Do not
   delete endpoints, credentials, database rows or storage objects during an incident.
3. Leave failed and pending jobs, capture evidence and analyses intact. Record only safe IDs,
   statuses and timestamps in the incident note.

### Roll back application code

1. Keep dispatch paused. In Vercel, promote the last accepted deployment for `notfor.now` or revert
   the offending commit through the normal reviewed release path.
2. Do not reverse the production migration chain or mutate immutable analyses. Database changes in
   this v0 are forward-recovered: prepare and review a corrective migration, apply it, then deploy
   compatible code.
3. Restore the matching Vercel environment version through the dashboard if configuration caused
   the incident. Update the matching Vault entry through the Vault UI when rotating
   `JOBS_PROCESS_SECRET`; deploy both sides before resuming.

### Recover

1. Run `pnpm launch:check` offline, deploy the correction, and repeat only the failed smoke row.
2. A live lease is left alone. A lease older than ten minutes is recovered by the next claim and
   consumes another attempt. Retries wait one minute after attempt one and two minutes after attempt
   two; attempt three becomes terminal `failed`.
3. Never reset `attempts`, clear a terminal status, edit `last_error`, overwrite an analysis or
   delete the original evidence. If a corrected configuration warrants another run, enqueue a new
   job through a separately reviewed operator action so the failed attempt remains measurable.
4. Resume the named cron job only after the readiness check and bounded smoke path pass. Re-enable
   provider webhooks last, then confirm one normal capture without expanding diagnostic output.

For one bounded manual dispatch after a correction, load `JOBS_PROCESS_SECRET` and the operator-only
`JOBS_PROCESS_URL=https://notfor.now/api/jobs/process` from the ignored local environment file. Keep
shell tracing disabled. The secret is passed through curl configuration on stdin rather than in a
command argument, and the endpoint prints only claimed/succeeded/failed counts:

```bash
set +x
printf 'header = "Authorization: Bearer %s"\n' "$JOBS_PROCESS_SECRET" |
  curl --config - --silent --show-error --fail --request POST "$JOBS_PROCESS_URL"
```

The launch is complete only when every readiness capability is ready, the migration chain is
applied, the domain and signed webhooks are valid, every smoke row has its safe evidence, and pause
plus rollback ownership is understood. Do not treat a successful deployment alone as launch proof.

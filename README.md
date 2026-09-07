This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Automatic intent processing

Captured input is acknowledged as soon as it is stored. Supabase Cron separately dispatches
`POST /api/jobs/process` once per minute through pg_net. Each call claims at most ten intent
jobs; it never processes source-resolution jobs or returns analysis content. Provider calls have a
20-second timeout with SDK retries disabled; the route declares a 300-second execution budget.

1. Configure the Vercel server environment: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ANTHROPIC_API_KEY`, `ANTHROPIC_INTENT_MODEL`, and `JOBS_PROCESS_SECRET`. Use your secret
   manager to generate and store the bearer secret; do not put its value in SQL, shell history,
   source control, or logs. Deploy the application before enabling dispatch.
2. In the Supabase Dashboard's Vault interface, create entries named **`later_jobs_process_url`**
   (the full production HTTPS URL ending in `/api/jobs/process`, with no query or credentials)
   and **`later_jobs_process_secret`** (the same value as Vercel's `JOBS_PROCESS_SECRET`).
   Use Vault's UI for values, not a saved SQL snippet. Rotation takes effect on the next dispatch;
   update both the Vercel environment/deployment and Vault together.
3. Apply the versioned migrations to your intended project using `supabase db push` after linking
   it with `supabase link --project-ref "$SUPABASE_PROJECT_REF"`. The migration enables pg_cron,
   pg_net and Vault and installs the named `later-intent-processing` schedule. Reapplying the
   schedule updates that named job rather than creating another. Missing/empty Vault entries
   suppress dispatch; a missing server secret returns 503 and a wrong bearer returns 401.
4. Verify configuration and activity with these queries. They deliberately select no secrets,
   request headers, response bodies, or captured content:

```sql
select name from vault.secrets
where name in ('later_jobs_process_url', 'later_jobs_process_secret');
select jobid, jobname, schedule, active from cron.job
where jobname = 'later-intent-processing';
select status, start_time, end_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'later-intent-processing')
order by start_time desc limit 10;
select id, status_code, timed_out, created from net._http_response
order by created desc limit 10;
select id, status, attempts, available_at, locked_at, completed_at, last_error
from public.capture_jobs where job_type = 'intent_analysis'
order by created_at desc limit 10;
```

A successful cron entry means dispatch SQL ran, not that HTTP or analysis succeeded. After a
capture, check for an HTTP 200 and a job with `status = 'completed'`; responses contain only
`claimed`, `succeeded`, and `failed` counts. pg_net queues request headers temporarily, so keep
Vault and the `net` schema restricted to trusted database operators. Never dump those tables
or enable HTTP debug logging to diagnose authentication.

For a manual smoke test or recovery drain, load `JOBS_PROCESS_SECRET` and `JOBS_PROCESS_URL`
(the same full URL stored in Vault) into your shell environment using your secret manager.
Run this with shell tracing disabled. It sends the header through stdin rather than putting
its value in curl's process arguments, and prints only the endpoint's count response:

```bash
set +x
printf 'header = "Authorization: Bearer %s"\n' "$JOBS_PROCESS_SECRET" |
  curl --config - --silent --show-error --fail --request POST "$JOBS_PROCESS_URL"
```

Failed attempts wait one minute after attempt one and two minutes after attempt two. Attempt
three is terminal `failed`; `last_error` contains only an allowlisted error code. Manual calls
respect `available_at` and cannot bypass the retry delay. A processing lease older than ten
minutes is recovered on the next claim cycle, consuming the next attempt; an expired third
attempt becomes terminal. A live lease is left alone. Analysis insertion, optional resolution
queueing and job completion commit together, and expired workers cannot publish results.

For terminal failures, correct the configuration/provider problem and explicitly enqueue a
new intent job for the chosen capture if a new run is wanted. Keep the failed job as evidence;
do not reset its attempt counter or alter a live lease. To pause automatic calls:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'later-intent-processing'), active := false
);
```

Use `active := true` to resume. Manual authenticated calls still work while the schedule is paused.
Local database verification: start a separate Supabase project and set `SUPABASE_TEST_DB_URL`
to its local test administrator connection (the concurrency test uses dblink). Run
`supabase test db --db-url "$SUPABASE_TEST_DB_URL"`. Use an isolated local database only.
The scheduler test rolls back its synthetic Vault values before pg_net can send a request.

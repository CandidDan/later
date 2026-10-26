---
id: "later-0024"
title: "Extract faithful full article text safely, or record honestly why it cannot be narrated"
status: "ready"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G3", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Fetches untrusted public URLs (SSRF boundary), adds a durable job type and private content table with RLS."
touches:
  - "src/lib/resolution/**"
  - "src/lib/jobs/**"
  - "src/app/api/jobs/process/**"
  - "src/lib/operations/**"
  - "supabase/migrations/*_article_extraction.sql"
  - "supabase/tests/database/article_extraction.test.sql"
  - "package.json"
  - "pnpm-lock.yaml"
  - "README.md"
labels: ["backend", "narration", "security"]
notes:
  - "2026-10-26 (orchestrator): independent of the iOS track; can run in parallel with later-0023 and later-0025 (touches checked disjoint). later-0026 consumes the table this creates."
---

## Context

V1 narrates saved articles faithfully, in full (VISION.md G4, NG3: narration changes delivery
format, never meaning; no summaries). Today Later resolves a capture's **source**
(`capture_analyses` row with `analysis_type = 'source_resolution'`, result shape in
`src/lib/resolution/result.ts`: `{status, sourceType: youtube_video|spotify_episode|spotify_show|
podcast_episode|article|other, title, creator, canonicalUrl, …}`) but never stores article text:
`src/lib/resolution/metadata.ts` fetches at most 128 KiB, keeps only metadata, and already has
hardened SSRF protection (https only, no userinfo/port, public-address DNS pinning per redirect hop,
≤3 redirects, streamed size cap, closed error-code list).

This task adds a background **article extraction** step that produces either the complete readable
text of an article or an explicit, honest reason it cannot be narrated. Anything uncertain is *not*
narratable: the app will offer "Open original" instead. Partial text is never narrated.

## Scope

**Does**
- New job type `article_extraction`, added the way previous types were (drop/re-add
  `capture_jobs_job_type_check`; its own SECURITY DEFINER `claim_article_extraction_job()` and
  `finish_article_extraction_attempt(...)` granted to `service_role` only; same 3-attempt /
  10-minute lease / backoff rules), wired into `CaptureJobType`, `supabase-store.ts` RPC mapping and
  the fair rotation in `src/app/api/jobs/process/route.ts` (still ≤2 jobs per dispatch).
- Enqueue: exactly one `article_extraction` job when a `source_resolution` analysis is published
  with `status = 'resolved'` and `sourceType = 'article'` (DB trigger in the migration, idempotent).
  Every other source outcome is **not** fetched; the extraction table records it as
  `unsupported` with reason `not_an_article` (video/audio/podcast/other/unresolved) so the library
  can explain it without guessing.
- Table `capture_article_extractions` (append-only, update trigger raises, like `capture_analyses`):
  `id, capture_id, user_id, status ('full'|'partial'|'unsupported'|'failed'), reason (closed list:
  not_an_article, not_html, too_short, paywalled, truncated, extraction_failed, fetch_failed),
  source_url, title, byline, site_name, language, paragraphs jsonb (array of strings, only when
  full), word_count, content_sha256, extractor_version, created_at`. Owner-scoped RLS: the
  `authenticated` role may SELECT only `user_id = auth.uid()` **and only when that capture's
  `capture_revisit_state.first_exposed_at` is not null** (mirrors the existing storage-object
  policy in `20261006090000_capture_revisit_state.sql`). No authenticated writes.
- Fetch through the existing SSRF-safe machinery (export/reuse it from `src/lib/resolution/`; do not
  write a second fetcher): `text/html` only, 2 MiB cap, 10 s timeout, ≤3 redirects.
- Extract with `@mozilla/readability` over `jsdom` (scripts never run, no subresource loading).
  Classification, conservative by design:
  - `full` only if Readability returns content, ≥ 200 words, the body was **not** cut by the byte
    cap, and there is no paywall signal: JSON-LD `isAccessibleForFree: false` (including `hasPart`),
    `<meta property="article:content_tier">` of `locked`/`metered`, or an element whose class/id
    matches `/paywall|regwall|subscriber-only|premium-content/i`.
  - paywall signal → `partial`/`paywalled`; byte cap hit → `partial`/`truncated`; < 200 words →
    `unsupported`/`too_short`; non-HTML → `unsupported`/`not_html`; Readability null →
    `unsupported`/`extraction_failed`; network/SSRF refusal → retry, terminal `failed`/`fetch_failed`.
- Paragraphs are the article's text **verbatim in source order** (whitespace normalised only; no
  rewriting, reordering, summarising or model calls). Captions and nav chrome dropped by
  Readability are acceptable; inserted text is not.
- Launch-readiness / README operator docs list the sixth queue (`src/lib/jobs/operator-docs.test.ts`
  and `launch-readiness` tests stay green and are updated to cover it).

**Does not**
- Expose any API or app surface (later-0026). Generate audio. Call Anthropic.
- Fetch YouTube, Spotify, Instagram, X, TikTok or podcast pages.
- Change existing analyses, recall/exposure semantics or the revisit endpoints.

## Acceptance criteria

- [ ] Given a resolved `article` source analysis, when it is inserted, then exactly one
      `article_extraction` job is enqueued (re-insert/retry does not duplicate) — pgTAP in
      `supabase/tests/database/article_extraction.test.sql`.
- [ ] Given a non-article or unresolved source, then no fetch happens and an `unsupported` /
      `not_an_article` extraction is recorded — vitest in `src/lib/resolution/article/*.test.ts`
      plus pgTAP.
- [ ] Given fixture HTML of a complete article, when extracted, then status is `full` and the joined
      paragraphs equal the fixture's article text verbatim and in order — vitest
      `article-extraction.test.ts :: full article is verbatim and ordered`.
- [ ] Given fixtures with each paywall signal, a truncated body, a 150-word page and a non-HTML
      response, then each yields its exact `partial`/`unsupported` status and reason and stores no
      paragraphs — one vitest case per fixture.
- [ ] Given a private/loopback/redirect-to-private URL, then nothing is fetched beyond the existing
      SSRF guard and the job ends `failed`/`fetch_failed` after retries — vitest reusing the
      resolution SSRF fixtures.
- [ ] Given an authenticated owner, when the capture has no `first_exposed_at`, then SELECT on
      `capture_article_extractions` returns no rows; after `revisit_expose`, it returns the row;
      another user never sees it — pgTAP.
- [ ] Given an extraction row, when an UPDATE is attempted, then it raises — pgTAP.
- [ ] Given `POST /api/jobs/process`, then the rotation includes `article_extraction` and still
      processes at most two jobs — `src/app/api/jobs/process/route.test.ts`.
- [ ] build + lint + test + coverage pass (including the Docker pgTAP fixture and browser proofs,
      unchanged).

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Put the new code under `src/lib/resolution/article/` (already a security path).
- New dependencies: `@mozilla/readability`, `jsdom` (+ `@types/jsdom`), pinned exactly; resync the
  lockfile with the pinned pnpm.
- Migration filename `supabase/migrations/<timestamp>_article_extraction.sql`, timestamp after
  `20261006090000`. The DB fixture applies all migrations automatically.
- Production migration and deploy are human-operated (README); this task does not run them.

---
id: "later-0026"
title: "Serve the app's private library and narration text, recording exposure before release"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for later-0024 (the article extraction table this serves) and later-0023 (which adds src/lib/app/** to the security review paths)."
blocked_by: ["later-0023", "later-0024"]
serves: ["G2", "G3", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Releases private content; must keep the research recall/exposure guarantee intact and atomic."
touches:
  - "src/app/api/app/library/**"
  - "src/app/api/app/narrations/**"
  - "src/lib/app/**"
  - "src/lib/revisit/card.ts"
  - "src/lib/revisit/card.test.tsx"
  - "supabase/migrations/*_app_library.sql"
  - "supabase/tests/database/app_library.test.sql"
labels: ["backend", "narration", "security", "research-safeguard"]
notes:
  - "2026-10-26 (orchestrator): released automatically by flow-unblock when later-0023 and later-0024 are done."
---

## Context

The iPhone app needs two read endpoints: the owned **library** (for Saved and for choosing what to
narrate) and the **narration text** of one article. Both release private content, so both must
preserve the research safeguard: Later records *exposure* server-side **before** any content
leaves the server, and research excludes exposed captures that have no prior unaided recall
(`capture_revisit_state.first_exposed_at`, `revisit_expose(p_capture_id) → boolean` using
`auth.uid()`, trigger `capture_recall_exposure_guard`, view `research_pending_evaluations` —
all in `supabase/migrations/20261006090000_capture_revisit_state.sql`). Text the app downloads
for offline listening is covered because exposure is recorded before the download is returned;
nothing is ever released first and recorded later.

Auth and response conventions are the revisit ones (`src/lib/revisit/server.ts`,
`src/lib/revisit/handler.ts`): Bearer Supabase token, user must equal `RESEARCH_USER_ID`,
caller-bound Supabase client so RLS applies, `private, no-store`, `Vary: Authorization`, `nosniff`,
UUID ids else 404. Extraction rows come from later-0024's `capture_article_extractions`
(status `full|partial|unsupported|failed`, closed `reason` list, `paragraphs` only when `full`;
SELECT RLS already requires `first_exposed_at`).

## Scope

**Does**
- SECURITY DEFINER RPC `app_library_page(p_before timestamptz, p_before_id uuid, p_limit int)`
  granted to `authenticated` only: returns the caller's (`auth.uid()`) captures that are not
  consumed, newest `captured_at` first, keyset-paged, `p_limit` clamped 1–50, and **calls
  `revisit_expose` for every row it returns inside the same transaction** before returning
  (same pattern as `revisit_batch`). Deferred items are included (deferral only affects the
  return batch).
- `GET /api/app/library?before=<cursor>&limit=<n>` → `200 {items: LibraryItem[], nextCursor:
  string|null}`, where `LibraryItem = {captureId, title|null, creator|null, source|null,
  sourceUrl|null, savedAt, kind: "article"|"video"|"audio"|"post"|"text"|"other",
  listen: {state: "narratable"|"preparing"|"open_original", reason?: closed list, wordCount?,
  textVersion?}}`. Build fields with the existing card projection in `src/lib/revisit/card.ts`
  (reuse, don't fork; `sourceUrl` = its validated `sourceDestination ?? originalDestination`).
  `listen` mapping: latest extraction `full` → `narratable` with `wordCount` and
  `textVersion` = its `content_sha256`; extraction job pending/processing or source resolution not
  finished → `preparing`; anything else → `open_original` with the extraction `reason`
  (`not_an_article`, `paywalled`, `truncated`, `too_short`, `not_html`, `extraction_failed`,
  `fetch_failed`) or `no_source`. Instagram/X/TikTok/YouTube/Spotify map to `kind` video/audio/post
  and `open_original`.
- `GET /api/app/narrations/{captureId}`: calls `revisit_expose` **first**; if it returns false →
  404. Then reads the latest `full` extraction through RLS. Returns `200 {captureId, textVersion,
  title, byline|null, siteName|null, sourceUrl, intro, paragraphs, outro, wordCount}` where
  `intro` = "<title>. <By byline.> From <siteName or host>. Narrated by Later." and `outro` = "End
  of <title>, from <siteName or host>." (attribution is Later's narration and is returned
  separately so the app can label it; `paragraphs` are the stored paragraphs unchanged). Not
  narratable → `409 {status:"open_original", reason}` (exposure still recorded — the item was
  identified). `ETag` = textVersion.
- Pure mapping/assembly code in `src/lib/app/` with unit tests; routes stay thin.

**Does not**
- Change `revisit_expose`, `revisit_batch`, recall rules or existing revisit/research routes.
- Generate audio, summarise, translate or alter text.
- Add listening-progress storage (a separate follow-up if needed).

## Acceptance criteria

- [ ] Given an owner with unexposed captures, when `app_library_page` returns a page, then every
      returned capture has `first_exposed_at` set in the same transaction, and captures not returned
      remain unexposed — pgTAP `supabase/tests/database/app_library.test.sql`.
- [ ] Given an exposed capture without recall, then it no longer appears in
      `research_pending_evaluations` and a fresh recall is refused, while a capture with recall
      recorded earlier can still be rated — pgTAP, same file.
- [ ] Given another user's capture id, then neither endpoint returns or exposes it (404) — pgTAP +
      `src/app/api/app/narrations/route.test.ts`.
- [ ] Given a `full` extraction, when narration is requested, then exposure is recorded before the
      text read and the response paragraphs equal the stored paragraphs exactly — route test
      asserting call order and payload.
- [ ] Given `partial`/`unsupported`/`failed` or no extraction, then 409 `open_original` with the
      exact reason and no paragraphs — route test, one case per status.
- [ ] Given extraction pending, then the library item is `preparing`; given each reason, the item is
      `open_original` with that reason — `src/lib/app/library.test.ts`.
- [ ] Given 120 owned captures, when paging with `limit=50`, then pages are disjoint, ordered newest
      first, consumed items excluded, and `nextCursor` is null on the last page —
      `src/app/api/app/library/route.test.ts` + pgTAP.
- [ ] Given no/invalid/wrong-user token, then 401 and nothing is exposed — route tests.
- [ ] Every response carries `private, no-store`, `Vary: Authorization`, `nosniff` — route tests.
- [ ] build + lint + test + coverage pass.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Migration `supabase/migrations/<timestamp>_app_library.sql`, timestamp after later-0024's.
- `src/lib/revisit/card.ts` is in touches only to export/extend the existing projection for reuse;
  its current card output and tests must stay unchanged.

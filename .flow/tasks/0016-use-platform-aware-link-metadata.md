---
id: "later-0016"
title: "Use platform-aware metadata retrieval for captured links"
status: "in_progress"
priority: 3
project: "later"
owner: "claude-worker-20260929T071907Z"
created: "2026-09-29"
started: "2026-09-29T07:19:07Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G1"]
touches: ["src/lib/resolution/**"]
labels: ["resolution", "metadata", "youtube", "instagram", "security"]
notes:
  - "Production evidence on 2026-09-28/29: one WhatsApp YouTube capture and one WhatsApp Instagram Reel capture both completed initial Haiku intent analysis, then exhausted three source-resolution attempts with metadata_unavailable. The Instagram capture is e04277c1-2d9d-4df3-aa13-64ec3b861d44; its private URL/content must not be copied into code, fixtures, logs or task notes."
  - "A sanitized diagnostic against an unrelated public YouTube video returned a 1,415,582-byte watch page, above Later's 128 KiB metadata limit, while YouTube's oEmbed endpoint returned a 792-byte JSON response containing title and author. The safety limit is doing its job; the resolver is using the wrong retrieval surface."
---

## Context

Source resolution currently sends every captured URL through the generic bounded public-document
fetcher. That is appropriate for ordinary pages, but recognised platforms often serve large,
dynamic or bot-sensitive application pages. Later therefore retries a deterministic incompatibility
as though it were a transient outage, stores three failed analyses and learns nothing beyond the
platform already visible in the URL.

For YouTube, the canonical video identity is already derived safely and a small public oEmbed JSON
response supplies the title and creator needed by the existing deterministic direct-resolution path.
For Instagram, Later has no reviewed metadata API or credential contract. The live Reel URL is a
normal `/reel/<id>/` link with a tracking query parameter; repeatedly scraping it is neither a
reliable metadata strategy nor an honest retryable failure.

This task makes metadata retrieval platform-aware while preserving the generic SSRF-safe path for
ordinary public sites. It advances G1 by giving intent/source research the narrowest defensible
metadata and recording unknown when the platform does not provide an approved retrieval surface.

## Scope

- Route recognised platform URLs through explicit metadata behaviour before the generic public-page
  fetcher.
- For YouTube video URLs, derive the existing canonical watch URL, request the fixed HTTPS YouTube
  oEmbed endpoint with that URL as data, and reduce the bounded JSON response to title, creator and
  canonical URL. Ignore embed HTML and every field not required by Later's metadata contract.
- Keep the oEmbed request inside the existing public-address, timeout, redirect, byte and supported
  content-type boundaries. The endpoint host must be fixed/allow-listed rather than discovered from
  captured content.
- Canonicalise public Instagram post/Reel/TV URL shapes by removing query parameters and fragments.
  Until a separately reviewed, policy-compatible Instagram metadata provider exists, do not fetch
  the Instagram application page: record a non-retryable unsupported notice and complete source
  resolution as an explicit unresolved result.
- Preserve the existing generic metadata path, including all SSRF protections, for non-platform
  public HTTPS URLs.
- Distinguish retryable platform/network unavailability from permanent unsupported/not-found
  metadata using existing safe error/notice values; never persist response bodies, embed HTML,
  captured URLs, provider-controlled error text or credentials as diagnostics.
- Preserve captures, initial intent analyses and all prior failed source analyses unchanged.
- Do not add Meta/Google credentials, call the YouTube Data API or Meta Graph API, weaken byte/time
  limits, download media, retrieve captions/transcripts, add post-resolution intent re-analysis,
  modify database schemas, requeue production jobs or deploy production in this task.

## Acceptance criteria

- [ ] Given any supported `youtube.com`, mobile YouTube or `youtu.be` video URL, when platform
  metadata is requested, then Later calls only the fixed public YouTube oEmbed endpoint for that
  canonical video and never requests the full watch page.
- [ ] Given a valid bounded YouTube oEmbed response, when source resolution runs, then Later maps
  only its title and author into the existing metadata contract and stores one deterministic resolved
  source with the canonical video URL, immutable evidence and no Anthropic call.
- [ ] Given a malformed, unsupported-content or oversized oEmbed response, or an unsafe destination
  or redirect, when retrieval runs, then the content never reaches the model and source resolution
  records only an allow-listed non-retryable notice and an explicit unresolved result.
- [ ] Given a timeout, DNS/network failure, rate limit or server failure from the fixed YouTube
  metadata endpoint, when retrieval runs, then the source job follows the existing bounded retry
  policy using only the safe `metadata_unavailable` category and preserves every earlier analysis.
- [ ] Given a public Instagram `/reel/`, `/p/` or `/tv/` URL with tracking parameters, when source
  resolution runs without an approved Instagram provider, then Later canonicalises the URL, makes no
  request to the Instagram application page, stores one explicit unresolved result with an
  unsupported-platform notice, and does not retry the same deterministic condition three times.
- [ ] Given an ordinary public HTTPS URL outside the explicit platform routes, when metadata is
  requested, then the existing generic SSRF-safe fetch and reduction behaviour remains unchanged.
- [ ] Given any platform metadata failure, when its stored result and observable diagnostics are
  inspected, then they contain no captured URL, content identifier, response/embed body,
  provider-controlled error text or credential material.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

YouTube oEmbed is the deliberately minimal v0 path because title and author satisfy the current
direct-resolution contract without a new secret. Richer fields such as duration or caption
availability belong to a later YouTube Data API task only if the experiment proves they are needed.

Instagram enrichment is deliberately not guessed here. A future task may add a Meta-supported
provider only after its access, permission, retention and permitted-use terms are reviewed against
Later's intent-analysis use case. Until then, explicit unresolved is the correct measurable outcome.

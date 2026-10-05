---
id: "later-0018"
title: "Provide trusted capture cards and private attachment previews"
status: "in_progress"
priority: 3
project: "later"
owner: "01a10964-e642-7432-8904-88b7130aa8ab"
created: "2026-10-05"
started: "2026-10-05T00:10:17Z"
branch: "flow/later-0018-capture-cards"
pr: "https://github.com/CandidDan/later/pull/31"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G2", "G3"]
touches: ["src/lib/revisit/**", "src/app/api/revisit/cards/**", "src/app/api/revisit/assets/**"]
labels: ["revisit", "capture"]
notes: ["Approved direction: make daily saves recognisable, then provide a small return surface; keep research separate."]
---

## Context

The user captures genuine things to return to every day, but a week later the research console's raw links and attachment filenames are difficult to recognise. Provide the reusable authenticated data and card presentation foundation for a return surface (later-0020) and post-recall research (later-0021). This task does not change research's pre-recall context or create a feed.

## Scope

- Define a bounded capture-card projection and reusable accessible presentation under `src/lib/revisit/`. Include capture ID, original note/text, capture kind/channel, source platform/site, absolute saved date plus relative age, safe original destination, and available title/creator/content type/duration.
- Prefer factual title/creator from existing persisted metadata evidence; use a validated resolved source only with its evidence and label inferred fields explicitly. Never treat the model's interest summary as source metadata. Deterministically select the latest successful source-resolution run, breaking timestamp ties by ID; do not merge conflicting runs.
- Support capture-only cards before processing completes. Use original text, safe hostname and capture kind as honest fallbacks; unresolved, failed and pending enrichment remain usable. No invented titles or durations.
- Add owner-authenticated single-card and private asset-preview endpoints using the existing authorized v0 user policy and caller-bound Supabase/RLS. No service-role bypass. These are supporting endpoints, not a selection feed.
- Render stored raster images (JPEG/PNG/WebP/GIF) through the authenticated preview endpoint. Other stored files get filename/type and an authenticated download action; do not render email HTML, SVG, arbitrary embed HTML or documents inline. Missing/pending/failed assets show a neutral fallback.
- Allow only validated public HTTPS original/source destinations as external links; reject credentials, private/local destinations and unsafe schemes using existing URL validation. New-tab links use safe relationship attributes.
- No new provider fetches, remote thumbnails, playback, summarisation, schema changes, backfills, production requeues or changes to immutable capture/analysis evidence. later-0016 is not a prerequisite: supported metadata is opportunistic, and unavailable platforms use fallbacks.

## Acceptance criteria

- [ ] Given a capture with stored factual metadata, when its card is requested and rendered, then title, creator, source, kind, original note and readable saved date appear, with inferred fields distinguished and deterministic run selection proven for conflicting/tied runs.
- [ ] Given pending, failed, unresolved or malformed enrichment, when the card renders, then original capture context remains recognisable without fabricated fields or a crash, and only safe available destinations are clickable.
- [ ] Given a stored supported raster attachment, when its owner requests a preview, then the correct private bytes and content type are returned and rendered; missing/non-stored files and unsupported inline formats show a fallback or download action without executing content.
- [ ] Given anonymous, wrong-user and cross-owner card/asset requests, when these endpoints run, then no capture, filename, metadata or asset bytes are disclosed; successful responses use private no-store caching and no durable public storage URL is returned.
- [ ] Given malicious metadata, HTML, link schemes or asset paths, when a card or asset is requested/rendered, then text remains escaped, unsafe navigation is absent and asset access cannot escape the owned capture's stored object.
- [ ] Given long text, absent optional fields and dates spanning day/timezone boundaries, when a card renders, then content wraps without horizontal overflow, controls have accessible names and date/relative-age formatting is deterministic under a supplied clock/timezone.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Use existing dependencies. Tests must use synthetic fixtures, including realistic older WhatsApp links, emails and image captures. Image recognition in v1 comes from captured attachments; remote source thumbnails require a separate retrieval task if later evidence justifies them.

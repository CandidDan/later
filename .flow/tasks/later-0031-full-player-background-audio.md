---
id: "later-0031"
title: "Play narration in a full player that works locked, offline and with headphone controls, and resumes"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for later-0030 (rendered narration audio and its manifest)."
blocked_by: ["later-0030"]
serves: ["G3", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Audio session, background modes, remote commands and interruption handling are easy to get subtly wrong."
touches:
  - "ios/project.yml"
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
  - "ios/LaterKit/Sources/LaterKit/Playback/**"
  - "ios/LaterKit/Tests/LaterKitTests/Playback/**"
labels: ["ios", "player", "offline"]
---

## Context

Dan listens while running: phone locked, maybe no signal, headphones on. Audio is local `.m4a`
files rendered by later-0030, each with a manifest (`captureId, textVersion, duration, file`).
This task is the playback engine and the full Player screen; Listen (later-0032) and Siri
(later-0033) start playback through the queue API defined here.

## Scope

**Does**
- LaterKit `Playback/`: pure `PlaybackQueue` state (items, current index, position, remaining
  total, advance/skip/previous rules) and `ResumeStore` logic (position per `captureId` +
  `textVersion`; resume 5 s before the saved position; a position within 10 s of the end counts as
  finished and restarts from 0 next time; a changed `textVersion` resets the position).
- `PlayerEngine` (app): `AVAudioSession` category `.playback`, mode `.spokenAudio`;
  `UIBackgroundModes = audio` in `project.yml`; `AVQueuePlayer`/`AVAudioPlayer` over local files
  only (no network during playback); persists position every 5 s, on pause, on interruption and on
  backgrounding.
- Lock screen / Control Center via `MPNowPlayingInfoCenter` (title, source as artist, "Later" as
  album, duration, elapsed, rate) and `MPRemoteCommandCenter`: play, pause, toggle, skip forward
  30 s, skip back 15 s, next/previous item, change playback position. Headphone and AirPods
  play/pause route through these commands.
- Interruptions: pause on interruption begin; resume after end only when the system says
  `shouldResume`. Route change with `oldDeviceUnavailable` (headphones unplugged / AirPods out)
  pauses and does not auto-resume.
- Full Player screen: title, source, "Narrated by Later with an iPhone voice", progress scrubber
  with elapsed / remaining, play/pause, −15/+30, next/previous, the queue with total remaining,
  **Open original** and **Done with this** (existing action endpoint; consume only on explicit tap,
  never on reaching the end). A mini player above the tab bar opens it.
- Playback speed 1.0× default with 0.8–2.0× options; remaining times shown at current speed are
  labelled as such.

**Does not**
- Decide what to queue (later-0032 / later-0033). Stream audio. Mark anything consumed
  automatically. Sync progress to the server.

## Acceptance criteria

- [ ] Given a queue, then advance/previous/skip and remaining-total behave per the rules —
      `LaterKitTests/Playback/PlaybackQueueTests` (Linux + macOS).
- [ ] Given saved positions, then resume, near-end restart and textVersion reset follow the rules —
      `LaterKitTests/Playback/ResumeStoreTests`.
- [ ] Given the engine starts, then the session is `.playback`/`.spokenAudio` and Info.plist
      declares background audio — `LaterAppTests/PlayerEngineTests.testAudioSessionAndBackgroundMode`.
- [ ] Given each remote command, then the engine performs the matching action and updates
      now-playing info — `PlayerEngineTests.testRemoteCommands` (commands invoked via the handlers).
- [ ] Given an interruption begin/end with and without `shouldResume`, and an
      `oldDeviceUnavailable` route change, then pause/resume behaviour matches — `PlayerEngineTests`
      (notifications posted with fixture userInfo).
- [ ] Given playback reaches the end of an item, then no consume action is sent —
      `PlayerEngineTests.testFinishingDoesNotConsume`.
- [ ] Given airplane mode (no network), then a ready item plays from its local file —
      `PlayerEngineTests.testPlaysWithoutNetwork` (URLProtocol stub fails all requests).
- [ ] Given a two-item queue in the simulator, the Player shows title, scrubber, queue and controls
      and play/pause toggles — `LaterAppUITests/PlayerUITests`.
- [ ] `ios-ci` and the Flow `ios/` check pass with floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Locked-device, headphone and lock-screen behaviour on real hardware is verified in later-0036.

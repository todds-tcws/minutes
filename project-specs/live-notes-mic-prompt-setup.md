# Minutes fork: live notes pane and meeting-detected prompt — Spec

> Spec-driven development: this file is the source of truth. Tasks, designs, tests and
> code trace back to a REQ-n below. Anything not here is out of scope. If reality proves the
> spec wrong, change the spec first (new version, dated), then resume the pipeline.

| Field | Value |
|---|---|
| Ticket | none (personal fork, todds-tcws/minutes) |
| Repo / branch | `~/Developer/01-Personal/minutes` · `feat/live-notes-mic-prompt` (stacked on `feat/notion-parity`) |
| Platform | macOS desktop (Rust + Tauri v2, plain HTML/JS frontend) |
| Version | 1.0 — 2026-09-22 (Claude, from Todd's intake answers) |
| Approved by | pending |

## 1. Problem, purpose and success (intake)

| Question | Answer | Source |
|---|---|---|
| What problem are we solving, in one sentence? | While Minutes records a meeting Todd cannot see what is being captured, and when a call starts the "record?" nudge is an OS notification plus an in-window banner instead of a Notion-style prompt he can act on or snooze in place. | requester |
| Who has this problem today, and what do they do about it now? | Todd, recording Teams/Slack/Zoom calls on his Mac. Today he opens the main window after the fact or relies on the summary; for prompts he clicks the notification or ignores it. | requester |
| How will we know it worked? | During a recording the main window shows the transcript growing live with his notes inline; when a call starts a floating card appears top-right within a second offering Record / Not now / snooze, and snoozed apps stop nagging. | requester (paraphrased) |
| What happens if we do nothing? | Recording stays a black box until processing finishes; repeat prompts for calls he does not want recorded keep interrupting meetings (the same complaint users have about Notion). | *(derived)* |
| Why now? | Notion-parity round 2 on the fork; round 1 (detection, storage picker, recording pill, Outlook feed) landed 2026-09-21/22. | requester |
| Hard constraints we must not violate? | Everything stays local on the Mac; no new network calls. Honor `privacy.hide_from_screen_share`. Do not replace `/Applications/Minutes.app`; dev installs go through `./scripts/install-dev-app.sh`. Never install while a recording is active. | requester + repo rules |
| What is explicitly NOT part of this? | Windows/Linux parity; auto-starting a recording without confirmation; screenshots (Todd's ask "see Minutes in my own screenshots" is already the existing Settings > Privacy toggle and needs no code); Coach HUD changes; changes to detection thresholds beyond snooze gating. | requester |

Links: fork plan `tasks/todo.md` (git-excluded); round 1 commits 8ed205e8, dacfbeb2, d415c64b on `feat/notion-parity`; Notion reference: desktop card reads roughly "In a meeting? Start AI Meeting Notes", appears at join time, has no snooze (Notion help center, HN thread 44594790).

## 2. Goals and non-goals
- Goal: a live, scrolling transcript-and-notes pane in the main window for the whole recording.
- Goal: a Notion-style floating "In a meeting?" card with Record / Not now / snooze that replaces the OS notification and the in-window banner as the detection surface.
- Non-goal: showing speaker names or diarization live (the live transcript has `speaker: null`).
- Non-goal: editing transcript text live.
- Non-goal: a separate pop-out notes window.
- Non-goal: changing the call-detection ladder, `SAME_APP_REMINDER_SECS`, or `any_mic_app` semantics; only gating what the user sees.
- Non-goal: any network call, telemetry, or cloud model use.

## 3. Requirements

### REQ-1: Live transcript and notes pane while recording
**Statement**: While a recording is active, the main window's recording view shall show every live transcript line and every user note as they arrive, so the whole meeting is visible before processing.
**Serves**: "cannot see what is being captured" / success measure "transcript growing live with notes inline".
**Context**: the live transcript engine already writes `~/.minutes/live-transcript.jsonl` during recordings (one JSON object per line: `line`, `ts`, `offset_ms`, `duration_ms`, `text`, `speaker`) and `live-transcript-status.json`; the UI today only polls `cmd_live_transcript_status` for counts (`tauri/src/index.html` ~8560–8640) and clears `#live-bar` when a recording starts. Notes are appended by `cmd_add_note` (`commands.rs:7145`) into `~/.minutes/current-notes.md`.
**Acceptance**:
- AC-1.1: WHEN a recording is active AND `live-transcript.jsonl` gains a new line THE SYSTEM SHALL display that line (elapsed offset as `M:SS` plus text) in a scrolling pane in the recording view within 2 seconds, without re-reading lines already shown (incremental read from a line cursor via a new Tauri command with a Rust unit test).
- AC-1.2: WHEN the user adds a note through Add Note or the note window during a recording THE SYSTEM SHALL show that note in the same pane at its time position, visually distinct from transcript lines.
- AC-1.3: WHEN new content arrives AND the pane is scrolled to the bottom THE SYSTEM SHALL keep the newest content visible; WHEN the user has scrolled up THE SYSTEM SHALL keep their position and show a "Jump to latest" control.
- AC-1.4: WHEN the recording is paused (existing `paused` flag in `cmd_capture_status`) THE SYSTEM SHALL show a "Paused" marker in the pane and resume appending when unpaused.
- AC-1.5: WHEN a recording is active AND no transcript lines have arrived THE SYSTEM SHALL show the existing live-transcript diagnostic text (from `cmd_live_transcript_status`) in the pane instead of an empty area.
- AC-1.6: WHEN the recording stops THE SYSTEM SHALL keep the pane content visible until processing of that meeting completes or the user navigates away; WHEN the next recording starts THE SYSTEM SHALL clear it.
- AC-1.7: WHEN the pane is visible THE SYSTEM SHALL keep the existing recording bar controls (Coach, Add Note, Stop Recording) reachable without scrolling, and the main window SHALL still hide to tray on close as today.
- AC-1.8: WHEN the UI locale is zh-CN or pt-BR THE SYSTEM SHALL translate the new strings through `window.MinutesI18n.t` (keys added to `tauri/src/locales/*.js`).
**Priority**: must

### REQ-2: Notion-style meeting-detected prompt card with snooze
**Statement**: When call detection fires and no recording is active, the system shall show a floating always-on-top card at the top-right of the screen offering Record, Not now, and snooze, replacing the OS notification and the in-window banner.
**Serves**: "record? nudge is a notification plus banner" / success measure "floating card within a second, snoozed apps stop nagging".
**Context**: detection lives in `tauri/src-tauri/src/call_detect.rs` (emits `call:detected {app_name, process_name, is_reminder}` at ~633 and posts `show_user_notification` at ~617); the banner is `#call-detected-banner` in `index.html` ~5934 with listener ~15771 that also calls `cmd_show_main_window`. Reference windows: `meeting-prompt` (`main.rs:1364–1466`, top-right, hard-coded 1440 width) and `recording-hud` (`commands.rs:20589–20668`, flag set and `content_protected`). Calendar overlap: `minutes_core::calendar::events_overlapping(now)` (merges system calendar and ICS feed).
**Acceptance**:
- AC-2.1: WHEN `call:detected` fires with `is_reminder = false` AND no recording is active AND the app is not snoozed THE SYSTEM SHALL show within 1 second a floating card (decorations off, always on top, does not take keyboard focus from the meeting app, positioned at the top-right of the display that contains the cursor, honoring `privacy.hide_from_screen_share`) containing: heading "In a meeting?", the detected app name, the overlapping calendar event title when one exists, and buttons Record, Not now, and a snooze control.
- AC-2.2: WHEN Record is clicked THE SYSTEM SHALL start recording through the existing path (`cmd_start_recording` with `source: "call_detect"`, intent Call), close the card, and let the existing recording pill appear.
- AC-2.3: WHEN Not now is clicked OR 20 seconds pass without interaction THE SYSTEM SHALL close the card and suppress further prompts for that app until it stops using the microphone (this call).
- AC-2.4: WHEN the snooze control is used THE SYSTEM SHALL offer exactly: "Not for this call", "1 hour", "Never for <app>"; "1 hour" suppresses prompts for that app for 60 minutes; "Never for <app>" adds the app to a persisted `call_detection.ignored_apps` list in `~/.config/minutes/config.toml`.
- AC-2.5: WHEN an app is suppressed by AC-2.3 or AC-2.4 THE SYSTEM SHALL show neither the card, the OS notification, nor a reminder for it; the detection thread keeps running unchanged.
- AC-2.6: WHEN the card is enabled THE SYSTEM SHALL not post the OS "call detected" notification and SHALL not bring the main window to the front; the in-window banner is removed. WHEN the card window cannot be created THE SYSTEM SHALL fall back to the existing OS notification.
- AC-2.7: WHEN a recording starts by any other means while the card is showing THE SYSTEM SHALL close the card.
- AC-2.8: WHEN the user opens Settings > Call detection THE SYSTEM SHALL show a toggle "Ask with a floating prompt" (config `call_detection.prompt_card`, default on) and the ignored-apps list with a remove control per app; `docs/architecture/config.md` documents both keys.
- AC-2.9: WHEN the UI locale is zh-CN or pt-BR THE SYSTEM SHALL translate the card and settings strings through `window.MinutesI18n.t`.
- AC-2.10: Snooze bookkeeping (per-app until-mic-release, per-app until-timestamp, persisted never-list) SHALL be covered by Rust unit tests in the module that owns it.
**Priority**: must

## 4. Screens / flows
| Screen | Serves | States required |
|---|---|---|
| Recording view, transcript pane (`index.html`) | REQ-1 | empty-with-diagnostic, streaming, paused, scrolled-up with jump control, stopped-awaiting-processing |
| Meeting-detected card (`tauri/src/meeting-detected.html`, new window label) | REQ-2 | with calendar title, without calendar title, snooze menu open, auto-dismiss at 20s |
| Settings > Call detection (`index.html`) | REQ-2 | toggle on/off, ignored-apps empty, ignored-apps with entries |

## 5. Constraints
- Stack: Rust workspace (`crates/core` = `minutes-core`, `tauri/src-tauri` = `minutes-app`), Tauri v2, frontend is plain HTML/JS with no bundler or framework; i18n via `window.MinutesI18n.t` with English strings as keys.
- Toolchain: Homebrew rust (repo pin ignored). Run `cargo clippy --all --no-default-features -- -D warnings -A clippy::chunks_exact_to_as_chunks`, `cargo fmt --all -- --check`, `cargo test -p minutes-core --no-default-features`, `cargo test -p minutes-app --bin minutes-app`.
- Desktop app has no tracing subscriber; `tracing::info!` is not logged. Use the existing `show_user_notification`/events for anything user-visible.
- Never replace `/Applications/Minutes.app`. Dev install only via `MINUTES_DEV_SIGNING_IDENTITY="Apple Development: Todd Stoel (CC2G5TPS8Q)" ./scripts/install-dev-app.sh`, and never while `~/.minutes/recording.pid` exists.
- Privacy: no network calls added; new windows pass `content_protected(config.privacy.hide_from_screen_share)`.
- Minimal diff: reuse the `meeting-prompt` positioning and `recording-hud` window flags; do not refactor adjacent code.

## 6. Open questions and defaults taken
- Default: the pane polls once per second (matches the recording pill) rather than adding a per-utterance event; upgrade path is an event if polling shows cost. Owner: Todd.
- Default: auto-dismiss at 20 seconds counts as "Not for this call". Owner: Todd.
- Default: "Never for <app>" keys on the app display name produced by detection (e.g. "Microsoft Teams", "Slack", "Google Chrome"). Owner: Todd.
- Default: the card does not pass a title into `cmd_start_recording`; the calendar title is still applied at processing time as today. Owner: Todd.
- Resolved out of band: "see Minutes in my own screenshots" = turn off Settings > Privacy > hide from screen share (existing). The Coach HUD stays hidden by design.

## 7. Change log
| Version | Date | Change | Why |
|---|---|---|---|
| 1.0 | 2026-09-22 | Initial | Todd's round-2 asks after the 2026-09-22 intake round |

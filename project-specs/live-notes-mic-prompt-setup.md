# Minutes fork: live notes pane and meeting-detected prompt — Spec

> Spec-driven development: this file is the source of truth. Tasks, designs, tests and
> code trace back to a REQ-n below. Anything not here is out of scope. If reality proves the
> spec wrong, change the spec first (new version, dated), then resume the pipeline.

| Field | Value |
|---|---|
| Ticket | none (personal fork, todds-tcws/minutes) |
| Repo / branch | `~/Developer/01-Personal/minutes` · `feat/live-notes-mic-prompt` (stacked on `feat/notion-parity`) |
| Platform | macOS desktop (Rust + Tauri v2, plain HTML/JS frontend) |
| Version | 1.1 — 2026-09-22 (Claude, from Todd's intake answers; spec-review fixes) |
| Approved by | Todd, at the plan gate (planOnly run) before any build task starts |

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
- Non-goal: tray/menu-bar menu changes (no snooze or ignored-apps entries there) and CLI changes (`minutes record`, detection parity); both keep current behavior.
- Non-goal: keyboard-only or VoiceOver operation of the floating card this round. The card is mouse-driven like the existing recording pill; users who need an accessible path turn the card off (AC-2.11), which restores the OS notification, or start recording from the main window.

## 3. Requirements

### REQ-1: Live transcript and notes pane while recording
**Statement**: While a recording is active, the main window's recording view shall show every live transcript line and every user note as they arrive, so the whole meeting is visible before processing.
**Serves**: "cannot see what is being captured" / success measure "transcript growing live with notes inline".
**Context**: the live transcript engine already writes `~/.minutes/live-transcript.jsonl` during recordings (one JSON object per line: `line`, `ts`, `offset_ms`, `duration_ms`, `text`, `speaker`) and `live-transcript-status.json`; the UI today only polls `cmd_live_transcript_status` for counts (`tauri/src/index.html` ~8560–8640) and clears `#live-bar` when a recording starts. Notes are appended by `cmd_add_note` (`commands.rs:7145`) into `~/.minutes/current-notes.md`.
**Acceptance**:
- AC-1.1: WHEN a recording is active AND `live-transcript.jsonl` gains a new line THE SYSTEM SHALL display that line (its `offset_ms` rendered as `M:SS`, plus `text`) in a scrolling pane in the recording view within 2 seconds, without re-reading lines already shown. Mechanism: a new command `cmd_live_transcript_lines(after_line: u64)` in `commands.rs` returns `{ lines: [{line, offset_ms, text}], total_lines }` for lines with `line > after_line`, backed by a `minutes-core` function that is unit tested.
- AC-1.1a: WHEN `live-transcript.jsonl` is missing or unreadable THE SYSTEM SHALL return zero lines with `total_lines = 0` (no error surfaced to the pane; AC-1.5 text applies). WHEN a line is not valid JSON or lacks `line`/`text` THE SYSTEM SHALL skip it and continue with the next line. WHEN `total_lines` is smaller than the pane's cursor (file rotated or a new recording started) THE SYSTEM SHALL reset the cursor to 0 and clear the pane before appending.
- AC-1.2: WHEN the user adds a note through Add Note or the note window during a recording THE SYSTEM SHALL show that note in the same pane, ordered by its elapsed timestamp. Source: notes are already written to `~/.minutes/current-notes.md` as `[M:SS] text` (elapsed since recording start, paused time excluded, `notes.rs:204-205`), so ordering compares the note's `M:SS` with transcript `offset_ms`; no wall-clock reconciliation is needed. Distinction: a note row has a leading "Note" label and a 3px left border in the UI accent color, and is not selectable by the transcript "Jump to latest" logic other than as content.
- AC-1.3: WHEN new content arrives AND the pane is scrolled to the bottom THE SYSTEM SHALL keep the newest content visible; WHEN the user has scrolled up THE SYSTEM SHALL keep their position and show a "Jump to latest" control.
- AC-1.4: WHEN the recording is paused (existing `paused` flag in `cmd_capture_status`) THE SYSTEM SHALL show a "Paused" marker in the pane and resume appending when unpaused.
- AC-1.5: WHEN a recording is active AND no transcript lines have arrived THE SYSTEM SHALL show the existing live-transcript diagnostic text (from `cmd_live_transcript_status`) in the pane instead of an empty area.
- AC-1.6: WHEN the recording stops THE SYSTEM SHALL keep the pane content visible until processing of that meeting completes or the user navigates away; WHEN the next recording starts THE SYSTEM SHALL clear it.
- AC-1.7: WHEN the pane is visible AND the main window is at its minimum size (460x520, `main.rs:349`) or larger THE SYSTEM SHALL keep the existing recording bar controls (Coach, Add Note, Stop Recording) fully visible without scrolling the page (the pane itself scrolls internally), and the main window SHALL still hide to tray on close as today.
- AC-1.8: WHEN the UI locale is zh-CN or pt-BR THE SYSTEM SHALL translate the new strings through `window.MinutesI18n.t` (keys added to `tauri/src/locales/*.js`).
**Priority**: must

### REQ-2: Notion-style meeting-detected prompt card with snooze
**Statement**: When call detection fires and no recording is active, the system shall show a floating always-on-top card at the top-right of the screen offering Record, Not now, and snooze, replacing the OS notification and the in-window banner.
**Serves**: "record? nudge is a notification plus banner" / success measure "floating card within a second, snoozed apps stop nagging".
**Context**: detection lives in `tauri/src-tauri/src/call_detect.rs` (emits `call:detected {app_name, process_name, is_reminder}` at ~633 and posts `show_user_notification` at ~617); the banner is `#call-detected-banner` in `index.html` ~5934 with listener ~15771 that also calls `cmd_show_main_window`. Reference windows: `meeting-prompt` (`main.rs:1364–1466`, top-right, hard-coded 1440 width) and `recording-hud` (`commands.rs:20589–20668`, flag set and `content_protected`). Calendar overlap: `minutes_core::calendar::events_overlapping(now)` (merges system calendar and ICS feed).
**Acceptance**:
- AC-2.1: WHEN `call:detected` fires with `is_reminder = false` AND no recording is active AND `call_detection.prompt_card` is on AND the app is not suppressed (AC-2.3/2.4) THE SYSTEM SHALL show within 1 second a floating card window labelled `meeting-detected` (`tauri/src/meeting-detected.html`; decorations off, always on top, `focusable(false)` so the meeting app keeps keyboard focus, `content_protected(config.privacy.hide_from_screen_share)`) containing: heading "In a meeting?", the detected app name, the overlapping calendar event title when one exists, and buttons Record, Not now, and a snooze control.
- AC-2.1a: WHEN the card is shown THE SYSTEM SHALL position it at the top-right of the monitor that contains the current cursor position (Tauri `cursor_position()` + `monitor_from_point`), 16px from the top and right edges of that monitor's work area. This supersedes the hard-coded 1440px logic in `get_top_right_position` (`main.rs:1452-1466`); that helper is a pattern reference only and is not modified.
- AC-2.1b: WHEN `call:detected` fires with `is_reminder = true` THE SYSTEM SHALL do nothing on the card surface: no second card, no OS notification, no banner. (Reminders were the old surface's way of re-nagging; the card's suppression rules replace them. The detection thread and `SAME_APP_REMINDER_SECS` are unchanged.)
- AC-2.2: WHEN Record is clicked THE SYSTEM SHALL start recording through the existing path (`cmd_start_recording` with `source: "call_detect"`, intent Call), close the card, and let the existing recording pill appear.
- AC-2.3: WHEN Not now is clicked OR 20 seconds pass without interaction THE SYSTEM SHALL close the card and suppress further prompts for that app until detection reports the app is no longer on a call (the existing `call:ended` signal for that `process_name`), i.e. "this call". This state is in-memory only. For tests, the card page reads its auto-dismiss duration from the URL query `dismiss_ms` (default 20000) so a headless test can exercise the timer.
- AC-2.4: WHEN the snooze control is used THE SYSTEM SHALL offer exactly: "Not for this call", "1 hour", "Never for <app>". "Not for this call" behaves as AC-2.3. "1 hour" writes `{ app_name: until_rfc3339 }` into `~/.minutes/call-prompt-snooze.json` (0600, same pattern as `recording-pause.json`) so it survives an app restart; expired entries are pruned on read. "Never for <app>" appends the app display name to `call_detection.ignored_apps` in `~/.config/minutes/config.toml` and saves the config.
- AC-2.4a: WHEN detection fires for an app THE SYSTEM SHALL decide suppression in this order and stop at the first match: (1) app is in `ignored_apps` → suppressed; (2) app has an unexpired entry in the snooze ledger → suppressed; (3) app is in the in-memory this-call set → suppressed; otherwise → prompt. This decision function lives in `minutes-core` (`crates/core/src/call_prompt.rs`) with unit tests for each branch, expiry pruning, and a missing/corrupt ledger file (treated as empty).
- AC-2.5: WHEN an app is suppressed by AC-2.3 or AC-2.4 THE SYSTEM SHALL show neither the card, the OS notification, nor a reminder for it; the detection thread keeps running unchanged.
- AC-2.6: WHEN `call_detection.prompt_card` is on AND the card is shown THE SYSTEM SHALL not post the OS "call detected" notification and SHALL not bring the main window to the front. The `#call-detected-banner` markup and its listener in `index.html` are removed in both modes; the `#call-ended-banner` (stop countdown) is unchanged.
- AC-2.6a: WHEN creating the card window returns an error THE SYSTEM SHALL post the existing OS notification instead. Mechanism: a pure function `call_prompt_surface(prompt_card_on, card_result: Result<(), String>) -> Surface { Card, Notification }` in `commands.rs` decides this and is unit tested with an injected `Err`; the caller maps `Surface::Notification` to `show_user_notification`.
- AC-2.11: WHEN `call_detection.prompt_card` is off THE SYSTEM SHALL behave as today minus the banner: post the OS "call detected" notification for `is_reminder = false` and the "Recording is still off" notification for `is_reminder = true`, subject to the same suppression rules in AC-2.4a (ignored and snoozed apps get no notification either).
- AC-2.7: WHEN a recording starts by any other means while the card is showing THE SYSTEM SHALL close the card.
- AC-2.8: WHEN the user opens Settings > Call detection THE SYSTEM SHALL show a toggle "Ask with a floating prompt" (config `call_detection.prompt_card`, default on) and the ignored-apps list with a remove control per app; `docs/architecture/config.md` documents both keys.
- AC-2.9: WHEN the UI locale is zh-CN or pt-BR THE SYSTEM SHALL translate the card and settings strings through `window.MinutesI18n.t`.
- AC-2.10: WHEN the snooze ledger contains an entry whose `until` is in the past THE SYSTEM SHALL treat the app as not snoozed and remove the entry on the next write. WHEN Minutes restarts inside a "1 hour" window THE SYSTEM SHALL still suppress that app until the stored `until`. WHEN Minutes restarts THE SYSTEM SHALL forget all "this call" suppressions.
**Priority**: must

## 4. Screens / flows
| Screen | Serves | States required |
|---|---|---|
| Recording view, transcript pane (`index.html`) | REQ-1 | empty-with-diagnostic, streaming, paused, scrolled-up with jump control, stopped-awaiting-processing |
| Meeting-detected card (`tauri/src/meeting-detected.html`, window label `meeting-detected`) | REQ-2 | with calendar title, without calendar title, snooze menu open, auto-dismiss at 20s |
| Settings > Call detection (`index.html`) | REQ-2 | toggle on/off, ignored-apps empty, ignored-apps with entries |

## 5. Constraints
- Stack: Rust workspace (`crates/core` = `minutes-core`, `tauri/src-tauri` = `minutes-app`), Tauri v2, frontend is plain HTML/JS with no bundler or framework; i18n via `window.MinutesI18n.t` with English strings as keys.
- Toolchain: Homebrew rust (repo pin ignored). Run `cargo clippy --all --no-default-features -- -D warnings -A clippy::chunks_exact_to_as_chunks`, `cargo fmt --all -- --check`, `cargo test -p minutes-core --no-default-features`, `cargo test -p minutes-app --bin minutes-app`.
- Desktop app has no tracing subscriber; `tracing::info!` is not logged. Use the existing `show_user_notification`/events for anything user-visible.
- Never replace `/Applications/Minutes.app`. Dev install only via `MINUTES_DEV_SIGNING_IDENTITY="Apple Development: Todd Stoel (CC2G5TPS8Q)" ./scripts/install-dev-app.sh`, and never while `~/.minutes/recording.pid` exists.
- Privacy: no network calls added; new windows pass `content_protected(config.privacy.hide_from_screen_share)`.
- Minimal diff: reuse the `recording-hud` window flag set and the `meeting-prompt` payload/token pattern as references; do not refactor adjacent code. Where a reference conflicts with an AC, the AC wins (AC-2.1a).
- Accepted evidence under this pipeline (supersedes the CLAUDE.md click-test rule for the automated gates, because the user is recording on this machine): (a) `cargo test` output for every `minutes-core` and `commands.rs` unit test named after an AC id; (b) for HTML behaviour (AC-1.3, AC-1.4, AC-1.6, AC-1.7, AC-2.1, AC-2.3, AC-2.7) a Playwright script run against the page on `file://` with a stub `window.__TAURI__` that scripts `invoke`/`listen` responses, using `dismiss_ms` and a 460x520 viewport where relevant, with screenshots attached; (c) `cargo build -p minutes-app` succeeding. The final manual click test in `~/Applications/Minutes Dev.app` is performed by Todd after his recording ends and is recorded in the pipeline report as "pending user verification"; it is not a gate the agents run.

## 6. Open questions and defaults taken
- Default: the pane polls once per second (matches the recording pill) rather than adding a per-utterance event; upgrade path is an event if polling shows cost. Owner: Todd.
- Default: auto-dismiss at 20 seconds counts as "Not for this call". Owner: Todd.
- Default: "Never for <app>" keys on the app display name produced by detection (e.g. "Microsoft Teams", "Slack", "Google Chrome"). Owner: Todd.
- Default: the card does not pass a title into `cmd_start_recording`; the calendar title is still applied at processing time as today. Owner: Todd.
- Default: with the card toggle off, the OS notification is the surface (AC-2.11); there is no mode with zero feedback. Owner: Todd.
- Default: reminders never re-prompt on the card surface (AC-2.1b); snooze rules replace re-nagging. Owner: Todd.
- Default: "1 hour" snooze persists across restart in `~/.minutes/call-prompt-snooze.json`; "this call" is in-memory. Owner: Todd.
- Default: the card is mouse-only this round (non-goal above). Owner: Todd.
- Default: notes and transcript are ordered by elapsed `M:SS`, which `add_note` already records. Owner: Todd.
- Resolved out of band: "see Minutes in my own screenshots" = turn off Settings > Privacy > hide from screen share (existing). The Coach HUD stays hidden by design.

## 7. Change log
| Version | Date | Change | Why |
|---|---|---|---|
| 1.0 | 2026-09-22 | Initial | Todd's round-2 asks after the 2026-09-22 intake round |
| 1.1 | 2026-09-22 | Defined toggle-off surface (AC-2.11), reminder path (AC-2.1b), snooze persistence and decision order (AC-2.4/2.4a/2.10), window label, multi-display positioning (AC-2.1a), transcript file edge cases (AC-1.1a), note ordering and styling (AC-1.2), min-size viewport (AC-1.7), testable fallback (AC-2.6a), accepted evidence, non-goals for tray/CLI/accessibility | Spec review (testing-reality-checker) blocking gaps |

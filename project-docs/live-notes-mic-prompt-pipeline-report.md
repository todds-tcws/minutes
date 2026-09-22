# Live notes pane + meeting-detected prompt — Pipeline report

**Branch**: `feat/live-notes-mic-prompt` (stacked on `feat/notion-parity`, fork todds-tcws/minutes)
**Spec**: `project-specs/live-notes-mic-prompt-setup.md` v1.9 · **Tasks**: `project-tasks/live-notes-mic-prompt-tasklist.md`
**Run**: wf_963aa849-921 (7 tasks, 57 agents, ~5.1M tokens, 5h55m) plus a direct fix round.

## Verdict

**NEEDS_WORK, by design cap.** Every requirement is implemented and every automated gate is green after the fix round, but spec section 5 caps certification at NEEDS_WORK until release blocker RB-1 (Todd's click test in Minutes Dev) is recorded. Nothing else is open.

## Traceability

| REQ | Priority | Tasks | Commits | Tests | Satisfied |
|---|---|---|---|---|---|
| REQ-1 live transcript + notes pane | must | 1, 2 (+ fix round) | 4448ec9a, 116c6ad4, fix commit | 8 unit tests in `crates/core/src/live_view.rs` (AC-1.1, 1.2, 1.13, null-offset); Playwright `ac-1.3` to `ac-1.14` (13 specs) | Automated: yes. Real latency: RB-1 |
| REQ-2 meeting-detected card + snooze | should | 3, 4, 5, 6 (+ fix round) | de009542, 9dc44186, 259c4b8e, 5f678266, fix commit | 15 AC-named unit tests in `call_prompt.rs`/`config.rs`, 30 in `commands.rs`/`main.rs`/`call_detect.rs`; Playwright `ac-2.3` to `ac-2.17` | Automated: yes. Real latency: RB-1 |
| Verification gate | — | 7 | 6730e26e | fmt, clippy, tests, build, `ac-2.17` network diff guard | yes |

## What the pipeline found and what changed after it

Codex cross-review (branch level) required six fixes; the a11y gate blocked Task 6 on two. All applied in the fix round:

| Finding | Fix | Test |
|---|---|---|
| Pane and recording bar hidden below 720px (list-pane auto-collapse hides every child of `.app-left`) | A live pane holds the list pane open; collapses again when it hides | `ac-1.9` asserts no `sidebar-collapsed` while recording, controls visible, collapse returns after stop |
| Rotation reset consumed a stale page filtered by the old cursors, dropping rows | Shrinking page is discarded; next tick re-reads from cursor 0. Rows at or below the cursor are ignored | `ac-1.4` second case |
| Settings hid the pane, next tick re-showed it | Tick gates visibility on the Settings overlay | `ac-1.8` second case, three ticks |
| Slack→Zoom→Slack kept Slack's "this call" suppression | `note_active_call` returns `Replaced { previous_display_name }`; detector routes `on_call_ended` for it | `ac_2_8_direct_app_replacement_reports_the_ended_call` |
| Contrast test never rendered a note | Test renders a note row and reads its computed border against the effective background | `ac-1.12` |
| Off toggle label at 50% opacity was 4.42:1 | `is-off` class with `--toggle-off` token (5.3:1 dark, 4.7:1 light), applied in the shared `setSettingsToggle` | `ac-2.14` contrast case |
| Focus dropped to body after removing an ignored app | Focus moves to the next Remove button or the empty note | `ac-2.14` focus case |

Spec change requests resolved: Task 4 (spec 1.8, call-end cleanup on `clear_active_call`, payload read-not-drain, title bound to token), Task 5 (AC-2.7a: `consent.mode = require` is a documented known gap; Todd uses `remind`), Task 7 (AC-2.17 evidence scoped to code), Task 2 (FYI only: the sub-720px collapse is pre-existing; now handled while recording).

## Security

Final pass PASS. Two Low findings, neither blocking: a stale native-helper PID in `call_capture.rs` (pre-existing on `feat/notion-parity`), and the snooze ledger's temp file being 0644 for an instant before chmod (contents are app names and timestamps).

## Cross-engine reviewer

Codex ran on every task round and at branch level. Per-task verdicts are in the task list table. Branch verdict FAIL with the six fixes above; the fix round addressed all six. It did not re-run after the fix round.

## Test status at hand-off

- `cargo fmt --all -- --check`: clean
- `cargo clippy --all --no-default-features -- -D warnings -A clippy::chunks_exact_to_as_chunks`: clean
- `cargo test -p minutes-app --bin minutes-app`: 454 passed
- Playwright (`tauri/tests-e2e`): 53 passed
- `cargo test -p minutes-core --no-default-features`: 1910 passed, 1 failed (`summarize::tests::cancelling_owned_chat_process_stops_descendants_before_timeout`), reproduced failing on `feat/notion-parity` in a clean worktree: pre-existing

## Remaining work

1. **RB-1 (Todd)**: after install, (a) record and watch the pane fill within 2 s of speech; (b) join a Teams call with no recording active and see the card within 1 s; (c) exercise Not now, 1 hour, Never, Remove, and toggle-off-while-open. Record the result in spec section 5.
2. Merge `feat/live-notes-mic-prompt` into `feat/notion-parity` once RB-1 passes; push to the fork when Todd says so (not pushed).
3. Backlog, not this branch: pre-existing failing core test; toggle buttons lack `aria-labelledby` across all Settings toggles; ignored-apps rows lack list semantics.

## Lessons

- The spec reviewer needs else-branches and per-AC evidence in v1.0; six rounds were spent adding them.
- `resumeFromRunId` replays a cached reviewer failure when only the spec changed; start a fresh run.
- Cap the PM's task count in `repoNotes`; 2 REQs became 18 tasks unprompted.
- Evidence-QA against a stubbed invoke passes duplicate-delivery and cursor bugs that a cross-poll test catches; write the multi-tick case first.

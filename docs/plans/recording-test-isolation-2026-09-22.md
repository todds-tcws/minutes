# Recording interruption fix — 2026-09-22

## Intent and evidence

The user reports that meeting recording stops and restarting creates separate meeting entries, and authorizes a fix and local deployment. During two Sept 22 captures, test pipeline log entries preceded clean recording stops while Teams remained active. Existing logs do not identify the stop source, so historical causality is inferred. Inspection confirms that PID unit tests create the same unaddressed recording.stop file consumed by the desktop capture loop. Other tests overwrite recording metadata and processing status in the real home directory.

The selected fix isolates test filesystem state and records stop provenance. Automatic merging of existing meetings is excluded: separate files contain different recording segments and merging by title could combine unrelated meetings. Capture behavior, legitimate CLI stop requests, and permission identity must remain compatible.

## Requirements

- REQ-1: WHEN PID lifecycle tests run, THE SYSTEM SHALL place all recording sentinel, recording metadata, and processing-state writes and cleanup in a temporary home. AC-1: lifecycle coverage runs against that home; a regression preserves the exact bytes of simulated external live state.
- REQ-2: WHEN a recording consumes a stop sentinel, THE SYSTEM SHALL log the consumer PID and whether the request was addressed or legacy, without logging arbitrary sentinel contents. AC-2: isolated tests assert these fields and continued addressed/legacy stop behavior.
- REQ-3: WHEN native desktop capture ends, THE SYSTEM SHALL persist whether a stop flag, stop sentinel, helper exit, or helper wait error ended the loop. AC-3: all loop termination branches are accounted for; testable classification uses fixed reason values and omits meeting content.
- REQ-4: WHEN the fixed app is installed, THE SYSTEM SHALL preserve its development identity, refuse replacement during recording/processing, and verify the newly launched process. AC-4: signed bundle verification and running executable identification, plus regression/format/lint/build evidence.

## Validation and review

Run focused regression tests, the required core test suite, formatting and Clippy in an isolated test environment. Review the diff independently and record any unavailable gates. No test may use the operator's live home as its filesystem fixture. The local bd executable is unavailable; do not edit its database or create an alternate task tracker.

## Lessons

A process-local test lock is not filesystem isolation. Tests of stop signaling must never share control files with a real recorder. Persistent stop provenance is needed to distinguish capture failures, deliberate stops, and external control requests.

## Review and validation results

- REQ-1: seven core PID tests now use temporary homes. The external-state regression verifies sentinel, recording metadata, and processing-state bytes remain unchanged. The desktop error-notice test is also isolated so it cannot add false dictation errors to the live log.
- REQ-2: addressed and legacy stop requests retain their prior behavior. The new log regression was observed failing before the implementation, then passed with the other 16 PID tests. Arbitrary sentinel contents are excluded from logs.
- REQ-3: native capture now logs stop_flag, stop_sentinel, helper_exit (including success/code), and helper_wait_error. Independent read-only review found no blocking findings and confirmed recovery/cleanup behavior is unchanged.
- Formatting and diff checks pass. The focused desktop test passes (1 test). Release CLI/app compilation and strict signed-bundle verification pass with the existing Apple Development identity.
- Workspace Clippy passes with `-D warnings -A clippy::chunks_exact_to_as_chunks`. Unmodified code fails that newly introduced lint under installed Homebrew Rust 1.98.1; the repository's pinned Rust 1.95 toolchain and rustup are not installed here. No unrelated lint fixes or toolchain changes were made.
- The required cross-engine review was attempted but unavailable: Claude reported `Credit balance is too low`; the gate returned SKIPPED. A separate Codex agent reviewed the diff without editing it.
- Historical stop attribution remains inferred. The confirmed defect is real test writes to the operational stop sentinel; existing logs cannot prove which request ended each past capture. Persistent provenance is included for future diagnosis.
- Full core unit-test suite: **1,913 passed, 0 failed, 2 ignored**, run serially from the compiled no-default-features test harness inside a fresh process home and config/state directories. The live application log remained unchanged during validation.

## Deployment verification

Installed through `scripts/install-dev-app.sh` into `~/Applications/Minutes Dev.app` on 2026-09-22 at 17:00 EDT. The installer verified idle recording/processing before replacement and launched fresh PID 64866. The installed host executable SHA-256 matches the signed build exactly: `07e8b62a07811ac381af2e584d8217e236f538a62adaa914d2ab0ff842691401`. Strict bundle verification passes. The bundle identifier, Apple Development signing identity, and team remain unchanged. The native hotkey diagnostic returns 0 with Input Monitoring granted. Post-install status reports no active recording or processing. REQ-4 is satisfied; no live meeting was started as a test and no existing meeting files were merged or deleted.

Source fix: `e7c71509` on `fix/recording-test-isolation`, pushed to the origin fork. A rollback copy of the previous signed app is retained locally at `/private/tmp/Minutes Dev-before-recording-fix.app`. No public release or upstream merge was performed.

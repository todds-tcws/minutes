//! Suppression rules for the meeting-detected prompt card.
//!
//! Call detection fires far more often than the user wants to be asked, so
//! every detection passes through [`decide`] first. Three suppressions, in
//! order: apps the user turned off for good (`call_detection.ignored_apps`),
//! apps snoozed for an hour ([`SnoozeLedger`], on disk so a restart does not
//! clear it), and apps dismissed for the current call ([`CallPromptState`],
//! in memory so a restart *does*).
//!
//! The ledger is a viewer of its own file: missing, corrupt or expired
//! entries mean "not snoozed", never an error. Expired entries are dropped
//! the next time something is written, not on read — reading must not touch
//! the disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::config::Config;

/// Why a detection did not reach the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressReason {
    /// The app is in `call_detection.ignored_apps`.
    Ignored,
    /// The app has an unexpired entry in the snooze ledger.
    Snoozed,
    /// The app was dismissed with "Not now" during the current call.
    ThisCall,
}

/// What to do with a detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Show nothing, for this reason.
    Suppressed(SuppressReason),
    /// Surface the prompt (card or notification, chosen by the caller).
    Prompt,
}

/// Path of the snooze ledger (`~/.minutes/call-prompt-snooze.json`).
pub fn ledger_path() -> PathBuf {
    Config::minutes_dir().join("call-prompt-snooze.json")
}

/// `app_name` → the instant its snooze expires.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct SnoozeLedger {
    entries: HashMap<String, DateTime<Utc>>,
}

impl SnoozeLedger {
    /// Load the ledger from `~/.minutes`, dropping entries expired at `now`.
    pub fn load(now: DateTime<Utc>) -> Self {
        Self::load_from(&ledger_path(), now)
    }

    /// [`SnoozeLedger::load`] against an explicit path. A missing or invalid
    /// file is an empty ledger; nothing is written back.
    pub fn load_from(path: &Path, now: DateTime<Utc>) -> Self {
        let mut ledger: Self = std::fs::read_to_string(path)
            .ok()
            .and_then(|body| serde_json::from_str(&body).ok())
            .unwrap_or_default();
        ledger.entries.retain(|_, until| *until > now);
        ledger
    }

    /// Whether `app_name` is snoozed at `now`.
    pub fn is_snoozed(&self, app_name: &str, now: DateTime<Utc>) -> bool {
        self.entries.get(app_name).is_some_and(|until| *until > now)
    }

    /// Snooze `app_name` until `until`, replacing any existing entry.
    pub fn snooze(&mut self, app_name: &str, until: DateTime<Utc>) {
        self.entries.insert(app_name.to_string(), until);
    }

    /// Write the ledger to `~/.minutes`, dropping entries expired at `now`.
    pub fn save(&self, now: DateTime<Utc>) -> std::io::Result<()> {
        self.save_to(&ledger_path(), now)
    }

    /// [`SnoozeLedger::save`] against an explicit path. Atomic (temp + rename)
    /// and `0600`, like every other sidecar in `~/.minutes`.
    pub fn save_to(&self, path: &Path, now: DateTime<Utc>) -> std::io::Result<()> {
        let live = Self {
            entries: self
                .entries
                .iter()
                .filter(|(_, until)| **until > now)
                .map(|(app, until)| (app.clone(), *until))
                .collect(),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&live)
            .map_err(|e| std::io::Error::other(format!("serialize snooze ledger: {}", e)))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        set_owner_only(&tmp)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Whether a detection for `app_name` should surface, and if not, why.
///
/// Checked in order, stopping at the first match: ignored, snoozed, this
/// call. Everything else prompts.
pub fn decide(
    app_name: &str,
    now: DateTime<Utc>,
    ignored_apps: &[String],
    ledger: &SnoozeLedger,
    this_call: &HashSet<String>,
) -> Decision {
    if ignored_apps.iter().any(|app| app == app_name) {
        return Decision::Suppressed(SuppressReason::Ignored);
    }
    if ledger.is_snoozed(app_name, now) {
        return Decision::Suppressed(SuppressReason::Snoozed);
    }
    if this_call.contains(app_name) {
        return Decision::Suppressed(SuppressReason::ThisCall);
    }
    Decision::Prompt
}

/// Live prompt state: apps dismissed for the current call, and whether a card
/// is on screen. Both are deliberately in memory — a restart forgets them.
#[derive(Debug, Default)]
pub struct CallPromptState {
    this_call: HashSet<String>,
    card_open: bool,
}

impl CallPromptState {
    /// Apps dismissed for the current call.
    pub fn this_call(&self) -> &HashSet<String> {
        &self.this_call
    }

    /// Record a "Not now" for `app_name`.
    pub fn dismiss_this_call(&mut self, app_name: &str) {
        self.this_call.insert(app_name.to_string());
    }

    /// Forget the "Not now" for `app_name` (its call ended).
    pub fn call_ended(&mut self, app_name: &str) {
        self.this_call.remove(app_name);
    }

    /// Whether a card is currently on screen.
    pub fn is_card_open(&self) -> bool {
        self.card_open
    }

    /// Claim the single card slot. Returns `false` when one is already open,
    /// which is the whole guard: a second detection is ignored, not queued.
    pub fn try_open_card(&mut self) -> bool {
        if self.card_open {
            return false;
        }
        self.card_open = true;
        true
    }

    /// Release the card slot. Called from the window `Destroyed` handler, so
    /// it covers every close path including an OS close or a webview crash.
    pub fn card_closed(&mut self) {
        self.card_open = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-22T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn this_call(apps: &[&str]) -> HashSet<String> {
        apps.iter().map(|a| a.to_string()).collect()
    }

    // ── AC-2.1: decide order ──────────────────────────────────

    #[test]
    fn ac_2_1_ignored_app_is_suppressed_first() {
        let mut ledger = SnoozeLedger::default();
        ledger.snooze("Slack", now() + Duration::minutes(60));
        // Every rule matches; Ignored is the one reported.
        let decision = decide(
            "Slack",
            now(),
            &["Slack".to_string()],
            &ledger,
            &this_call(&["Slack"]),
        );
        assert_eq!(decision, Decision::Suppressed(SuppressReason::Ignored));
    }

    #[test]
    fn ac_2_1_snoozed_app_is_suppressed_before_this_call() {
        let mut ledger = SnoozeLedger::default();
        ledger.snooze("Slack", now() + Duration::minutes(60));
        let decision = decide("Slack", now(), &[], &ledger, &this_call(&["Slack"]));
        assert_eq!(decision, Decision::Suppressed(SuppressReason::Snoozed));
    }

    #[test]
    fn ac_2_1_this_call_app_is_suppressed() {
        let decision = decide(
            "Slack",
            now(),
            &[],
            &SnoozeLedger::default(),
            &this_call(&["Slack"]),
        );
        assert_eq!(decision, Decision::Suppressed(SuppressReason::ThisCall));
    }

    #[test]
    fn ac_2_1_unknown_app_prompts() {
        let mut ledger = SnoozeLedger::default();
        ledger.snooze("Zoom", now() + Duration::minutes(60));
        let decision = decide(
            "Microsoft Teams",
            now(),
            &["Slack".to_string()],
            &ledger,
            &this_call(&["Webex"]),
        );
        assert_eq!(decision, Decision::Prompt);
    }

    // ── AC-2.2: ledger persistence ────────────────────────────

    #[test]
    fn ac_2_2_missing_file_is_an_empty_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");
        let ledger = SnoozeLedger::load_from(&path, now());
        assert_eq!(ledger, SnoozeLedger::default());
        assert!(!path.exists(), "read must not create the file");
    }

    #[test]
    fn ac_2_2_corrupt_file_is_an_empty_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");
        std::fs::write(&path, "{not json at all").unwrap();
        assert_eq!(
            SnoozeLedger::load_from(&path, now()),
            SnoozeLedger::default()
        );
    }

    #[test]
    fn ac_2_2_expired_entry_ignored_on_read_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");
        let body = r#"{"Slack":"2026-09-22T11:00:00Z","Zoom":"2026-09-22T13:00:00Z"}"#;
        std::fs::write(&path, body).unwrap();

        let ledger = SnoozeLedger::load_from(&path, now());
        let mut expected = SnoozeLedger::default();
        expected.snooze("Zoom", now() + Duration::hours(1));
        assert_eq!(ledger, expected, "expired entry dropped at load");
        assert!(!ledger.is_snoozed("Slack", now()));
        assert!(ledger.is_snoozed("Zoom", now()));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            body,
            "no file write on read"
        );
    }

    #[test]
    fn ac_2_2_expired_entry_absent_after_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");
        let mut ledger = SnoozeLedger::default();
        ledger.snooze("Slack", now() - Duration::minutes(1));
        ledger.snooze("Zoom", now() + Duration::minutes(60));
        ledger.save_to(&path, now()).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("Slack"),
            "expired entry dropped: {written}"
        );
        assert!(written.contains("Zoom"));

        let reloaded = SnoozeLedger::load_from(&path, now());
        assert!(reloaded.is_snoozed("Zoom", now()));
    }

    #[cfg(unix)]
    #[test]
    fn ac_2_2_write_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");
        let mut ledger = SnoozeLedger::default();
        ledger.snooze("Zoom", now() + Duration::minutes(60));
        ledger.save_to(&path, now()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // ── AC-2.6: one card at a time ────────────────────────────

    #[test]
    fn ac_2_6_second_detection_is_ignored_while_a_card_is_open() {
        let mut state = CallPromptState::default();
        assert!(state.try_open_card(), "first detection opens the card");
        assert!(!state.try_open_card(), "second detection is ignored");
        assert!(state.is_card_open());

        state.card_closed();
        assert!(state.try_open_card(), "next detection prompts once closed");
    }

    // ── AC-2.10: what survives a restart ──────────────────────

    #[test]
    fn ac_2_10_restart_keeps_the_snooze_and_forgets_this_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("call-prompt-snooze.json");

        let mut state = CallPromptState::default();
        state.dismiss_this_call("Microsoft Teams");
        let mut ledger = SnoozeLedger::load_from(&path, now());
        ledger.snooze("Slack", now() + Duration::minutes(60));
        ledger.save_to(&path, now()).unwrap();
        drop(state);
        drop(ledger);

        // Fresh process: empty in-memory state, ledger reloaded from disk.
        let state = CallPromptState::default();
        let ledger = SnoozeLedger::load_from(&path, now() + Duration::minutes(30));
        let later = now() + Duration::minutes(30);
        assert_eq!(
            decide("Slack", later, &[], &ledger, state.this_call()),
            Decision::Suppressed(SuppressReason::Snoozed)
        );
        assert_eq!(
            decide("Microsoft Teams", later, &[], &ledger, state.this_call()),
            Decision::Prompt
        );
    }

    // ── AC-2.16: the card slot is released on destroy ─────────

    #[test]
    fn ac_2_16_card_closed_clears_the_open_flag() {
        let mut state = CallPromptState::default();
        state.try_open_card();
        state.card_closed();
        assert!(!state.is_card_open());
        state.card_closed();
        assert!(!state.is_card_open(), "card_closed is idempotent");
    }
}

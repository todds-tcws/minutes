//! Delta reads of the live transcript and the current notes file for the
//! recording pane in the desktop app.
//!
//! The pane polls [`read_since`] once per second with the cursors it has
//! already rendered and appends whatever comes back. Both sources are read
//! whole every poll: the files are small (one line per utterance) and a full
//! scan keeps the null-offset resolution below deterministic — the value a
//! note gets never depends on where a poll boundary fell.
//!
//! Neither source is allowed to fail the read. A missing, unreadable or torn
//! file yields zero items for that source, because the pane polling during a
//! live recording is a viewer, not a consistency check.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One transcript utterance for the live pane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveLine {
    /// The `line` field from the JSONL record (1-based, not a file position).
    pub line: u64,
    /// Milliseconds since session start.
    pub offset_ms: u64,
    /// Transcribed text.
    pub text: String,
}

/// One user note for the live pane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveNote {
    /// Physical 1-based line index in `current-notes.md`.
    pub note: u64,
    /// Milliseconds since recording start, resolved from the `[M:SS]` prefix.
    pub offset_ms: u64,
    /// Note text without the timestamp prefix.
    pub text: String,
}

/// Everything after a pair of cursors, plus the totals the pane needs to spot
/// a rotated file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveView {
    /// Transcript lines with `line > after_line`.
    pub lines: Vec<LiveLine>,
    /// Highest `line` value in the transcript file (0 when there is none).
    pub total_lines: u64,
    /// Notes with `note > after_note`.
    pub notes: Vec<LiveNote>,
    /// Physical line count of the notes file.
    pub total_notes: u64,
}

/// JSONL record as the pane needs it. Deliberately looser than
/// [`crate::live_transcript::TranscriptLine`]: a record missing `ts` or
/// `duration_ms` is still displayable, and a record missing `line` or `text`
/// is not.
#[derive(Deserialize)]
struct RawLine {
    line: u64,
    #[serde(default)]
    offset_ms: u64,
    text: String,
}

/// Read everything newer than the given cursors from the live transcript and
/// notes files in `~/.minutes`.
pub fn read_since(after_line: u64, after_note: u64) -> LiveView {
    read_since_in(
        &crate::pid::live_transcript_jsonl_path(),
        &crate::notes::notes_path(),
        after_line,
        after_note,
    )
}

/// [`read_since`] against explicit paths.
pub fn read_since_in(
    transcript_path: &Path,
    notes_path: &Path,
    after_line: u64,
    after_note: u64,
) -> LiveView {
    let (lines, total_lines) = read_transcript(transcript_path, after_line);
    let (notes, total_notes) = read_notes(notes_path, after_note);
    LiveView {
        lines,
        total_lines,
        notes,
        total_notes,
    }
}

fn read_transcript(path: &Path, after_line: u64) -> (Vec<LiveLine>, u64) {
    let Ok(body) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut lines = Vec::new();
    let mut total = 0;
    for raw in body.lines() {
        // A torn final line, a blank line or anything without `line`/`text`
        // is skipped; the next poll re-reads the file from the top and picks
        // it up once the writer has finished it.
        let Ok(parsed) = serde_json::from_str::<RawLine>(raw) else {
            continue;
        };
        total = total.max(parsed.line);
        if parsed.line > after_line {
            lines.push(LiveLine {
                line: parsed.line,
                offset_ms: parsed.offset_ms,
                text: parsed.text,
            });
        }
    }
    (lines, total)
}

fn read_notes(path: &Path, after_note: u64) -> (Vec<LiveNote>, u64) {
    let Ok(body) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut notes = Vec::new();
    let mut total = 0;
    // A `?:??` note took its timestamp before the recording start was
    // readable. It belongs with the note before it, so it sorts next to its
    // neighbour in the pane instead of jumping to the top.
    let mut last_offset_ms = 0;
    for (index, raw) in body.lines().enumerate() {
        // Physical line numbering: a skipped line still consumes a number, so
        // the cursor stays aligned with the file no matter what is in it.
        let note = index as u64 + 1;
        total = note;
        let Some((offset_ms, text)) = parse_note(raw) else {
            continue;
        };
        let offset_ms = match offset_ms {
            Some(value) => {
                last_offset_ms = value;
                value
            }
            None => last_offset_ms,
        };
        if note > after_note {
            notes.push(LiveNote {
                note,
                offset_ms,
                text: text.to_string(),
            });
        }
    }
    (notes, total)
}

/// Split `[M:SS] text` into its offset and its text. `None` for a line
/// without the prefix; `Some((None, _))` for the `?:??` placeholder
/// `add_note` writes when elapsed time is unknown.
///
/// The stamp is validated against exactly what `notes::add_note` writes
/// (`format!("{}:{:02}", mins, secs)`, `notes.rs:171`): unsigned digits for
/// the minutes — which are unbounded, a long recording passes 59 — and
/// exactly two digits in `00`..=`59` for the seconds. Anything else is a
/// malformed line and is skipped by the caller, including a minute count so
/// large that its milliseconds overflow `u64`.
fn parse_note(raw: &str) -> Option<(Option<u64>, &str)> {
    let rest = raw.strip_prefix('[')?;
    let (stamp, text) = rest.split_once(']')?;
    let text = text.strip_prefix(' ').unwrap_or(text);
    if stamp == "?:??" {
        return Some((None, text));
    }
    let (mins, secs) = stamp.split_once(':')?;
    if !mins.bytes().all(|b| b.is_ascii_digit()) || mins.is_empty() {
        return None;
    }
    if secs.len() != 2 || !secs.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mins: u64 = mins.parse().ok()?;
    let secs: u64 = secs.parse().ok()?;
    if secs > 59 {
        return None;
    }
    let offset_ms = mins.checked_mul(60)?.checked_add(secs)?.checked_mul(1000)?;
    Some((Some(offset_ms), text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        _dir: tempfile::TempDir,
        transcript: PathBuf,
        notes: PathBuf,
    }

    impl Fixture {
        fn new(transcript: &str, notes: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let transcript_path = dir.path().join("live-transcript.jsonl");
            let notes_path = dir.path().join("current-notes.md");
            std::fs::write(&transcript_path, transcript).unwrap();
            std::fs::write(&notes_path, notes).unwrap();
            Self {
                _dir: dir,
                transcript: transcript_path,
                notes: notes_path,
            }
        }

        fn read(&self, after_line: u64, after_note: u64) -> LiveView {
            read_since_in(&self.transcript, &self.notes, after_line, after_note)
        }
    }

    fn jsonl(entries: &[(u64, u64, &str)]) -> String {
        entries
            .iter()
            .map(|(line, offset_ms, text)| {
                format!(
                    r#"{{"line":{},"ts":"2026-09-22T10:0{}:00-04:00","offset_ms":{},"duration_ms":1000,"text":"{}","speaker":null}}"#,
                    line, line, offset_ms, text
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    /// AC-1.1: only items past the cursors, plus the current totals.
    #[test]
    fn ac_1_1_read_since_returns_only_items_past_the_cursors() {
        let fixture = Fixture::new(
            &jsonl(&[(1, 0, "one"), (2, 5000, "two"), (3, 9000, "three")]),
            "[0:03] first note\n[0:07] second note\n",
        );

        let all = fixture.read(0, 0);
        assert_eq!(all.total_lines, 3);
        assert_eq!(all.total_notes, 2);
        assert_eq!(
            all.lines,
            vec![
                LiveLine {
                    line: 1,
                    offset_ms: 0,
                    text: "one".into()
                },
                LiveLine {
                    line: 2,
                    offset_ms: 5000,
                    text: "two".into()
                },
                LiveLine {
                    line: 3,
                    offset_ms: 9000,
                    text: "three".into()
                },
            ]
        );
        assert_eq!(
            all.notes,
            vec![
                LiveNote {
                    note: 1,
                    offset_ms: 3000,
                    text: "first note".into()
                },
                LiveNote {
                    note: 2,
                    offset_ms: 7000,
                    text: "second note".into()
                },
            ]
        );

        let tail = fixture.read(2, 2);
        assert_eq!(tail.total_lines, 3);
        assert_eq!(tail.total_notes, 2);
        assert_eq!(tail.lines.len(), 1);
        assert_eq!(tail.lines[0].line, 3);
        assert!(tail.notes.is_empty());
    }

    /// AC-1.13: a relaunch mid-recording starts both cursors at 0 and gets the
    /// whole file back — the same call the pane makes on its first poll.
    #[test]
    fn ac_1_13_cursor_zero_returns_every_existing_line_and_note() {
        let fixture = Fixture::new(
            &jsonl(&[(1, 0, "one"), (2, 5000, "two"), (3, 9000, "three")]),
            "[0:03] first note\n[0:07] second note\n",
        );

        let first_poll = fixture.read(0, 0);

        assert_eq!(first_poll.lines.len(), 3);
        assert_eq!(first_poll.notes.len(), 2);
        assert_eq!(first_poll.total_lines, 3);
        assert_eq!(first_poll.total_notes, 2);
    }

    /// AC-1.2: a missing file is zero items and total 0 for that source only.
    #[test]
    fn ac_1_2_missing_files_read_as_empty_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("live-transcript.jsonl");
        let notes = dir.path().join("current-notes.md");
        std::fs::write(&transcript, jsonl(&[(1, 0, "one")])).unwrap();

        let no_notes = read_since_in(&transcript, &notes, 0, 0);
        assert_eq!(no_notes.lines.len(), 1);
        assert_eq!(no_notes.total_lines, 1);
        assert!(no_notes.notes.is_empty());
        assert_eq!(no_notes.total_notes, 0);

        std::fs::remove_file(&transcript).unwrap();
        std::fs::write(&notes, "[0:03] a note\n").unwrap();

        let no_transcript = read_since_in(&transcript, &notes, 0, 0);
        assert!(no_transcript.lines.is_empty());
        assert_eq!(no_transcript.total_lines, 0);
        assert_eq!(no_transcript.notes.len(), 1);
        assert_eq!(no_transcript.total_notes, 1);

        let neither = read_since_in(
            &dir.path().join("nope.jsonl"),
            &dir.path().join("nope.md"),
            0,
            0,
        );
        assert_eq!(neither, LiveView::default());
    }

    /// AC-1.2: an unreadable path (a directory here) is empty for that source
    /// only — the other source still reads, so the failure cannot be papered
    /// over by returning [`LiveView::default()`] for the whole call.
    #[test]
    fn ac_1_2_unreadable_files_read_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let unreadable_transcript = dir.path().join("transcript-dir");
        let unreadable_notes = dir.path().join("notes-dir");
        std::fs::create_dir(&unreadable_transcript).unwrap();
        std::fs::create_dir(&unreadable_notes).unwrap();
        let good_transcript = dir.path().join("live-transcript.jsonl");
        let good_notes = dir.path().join("current-notes.md");
        std::fs::write(&good_transcript, jsonl(&[(1, 0, "one"), (2, 4000, "two")])).unwrap();
        std::fs::write(&good_notes, "[0:03] a note\n").unwrap();

        let notes_survive = read_since_in(&unreadable_transcript, &good_notes, 0, 0);
        assert!(notes_survive.lines.is_empty());
        assert_eq!(notes_survive.total_lines, 0);
        assert_eq!(
            notes_survive.notes,
            vec![LiveNote {
                note: 1,
                offset_ms: 3000,
                text: "a note".into()
            }]
        );
        assert_eq!(notes_survive.total_notes, 1);

        let lines_survive = read_since_in(&good_transcript, &unreadable_notes, 0, 0);
        assert_eq!(lines_survive.lines.len(), 2);
        assert_eq!(lines_survive.total_lines, 2);
        assert!(lines_survive.notes.is_empty());
        assert_eq!(lines_survive.total_notes, 0);

        assert_eq!(
            read_since_in(&unreadable_transcript, &unreadable_notes, 0, 0),
            LiveView::default()
        );
    }

    /// AC-1.2: a timestamp that is not the `M:SS` `add_note` writes — signed
    /// minutes, one or three seconds digits, seconds past 59, non-digits, or a
    /// minute count whose milliseconds overflow `u64` — is skipped like any
    /// other malformed prefix, the scan continues to the valid notes after it,
    /// and every skipped line still consumes its physical note number.
    #[test]
    fn ac_1_2_notes_with_invalid_timestamps_are_skipped() {
        // u64::MAX / 60_000 is 307_445_734_561_825, so the minute count below
        // parses fine and only overflows when converted to milliseconds.
        let fixture = Fixture::new(
            "",
            concat!(
                "[+1:00] signed minutes\n",
                "[0:7] one second digit\n",
                "[0:075] three second digits\n",
                "[0:60] seconds out of range\n",
                "[0:0x] non digit seconds\n",
                "[307445734561826:00] overflows milliseconds\n",
                "[2:05] still parsed\n",
                "[?:??] still resolved\n",
            ),
        );

        let view = fixture.read(0, 0);

        assert_eq!(
            view.notes,
            vec![
                LiveNote {
                    note: 7,
                    offset_ms: 125_000,
                    text: "still parsed".into()
                },
                LiveNote {
                    note: 8,
                    offset_ms: 125_000,
                    text: "still resolved".into()
                },
            ]
        );
        assert_eq!(view.total_notes, 8);
    }

    /// AC-1.2: bad JSON, a missing `line` and a missing `text` are skipped and
    /// the scan continues past them.
    #[test]
    fn ac_1_2_malformed_transcript_lines_are_skipped() {
        let fixture = Fixture::new(
            concat!(
                r#"{"line":1,"ts":"2026-09-22T10:01:00-04:00","offset_ms":0,"duration_ms":10,"text":"one","speaker":null}"#,
                "\n",
                "not json at all\n",
                "\n",
                r#"{"ts":"2026-09-22T10:02:00-04:00","offset_ms":1000,"text":"no line number"}"#,
                "\n",
                r#"{"line":3,"offset_ms":2000}"#,
                "\n",
                r#"{"line":4,"offset_ms":3000,"text":"four"}"#,
                "\n",
                r#"{"line":5,"ts":"2026-09-22T10:0"#,
            ),
            "",
        );

        let view = fixture.read(0, 0);

        assert_eq!(
            view.lines,
            vec![
                LiveLine {
                    line: 1,
                    offset_ms: 0,
                    text: "one".into()
                },
                LiveLine {
                    line: 4,
                    offset_ms: 3000,
                    text: "four".into()
                },
            ]
        );
        assert_eq!(view.total_lines, 4);
    }

    /// AC-1.2: a note line without the `[M:SS]` prefix is skipped, but it
    /// still consumes its physical note number.
    #[test]
    fn ac_1_2_notes_without_a_timestamp_prefix_are_skipped() {
        let fixture = Fixture::new(
            "",
            "no prefix here\n[0:09] real note\n[bogus] also skipped\n",
        );

        let view = fixture.read(0, 0);

        assert_eq!(
            view.notes,
            vec![LiveNote {
                note: 2,
                offset_ms: 9000,
                text: "real note".into()
            }]
        );
        assert_eq!(view.total_notes, 3);
    }

    /// The `?:??` placeholder resolves to the nearest preceding note with a
    /// real offset — including when that predecessor was returned by an
    /// earlier poll — so the value never depends on where the cursor fell.
    /// (Feeds AC-1.3's ordering evidence in the pane task.)
    #[test]
    fn null_offset_note_resolves_to_its_predecessor() {
        let fixture = Fixture::new(
            "",
            "[?:??] before any offset\n[1:05] anchor\n[?:??] after\n",
        );

        let from_scratch = fixture.read(0, 0);
        assert_eq!(from_scratch.notes[0].offset_ms, 0);
        assert_eq!(from_scratch.notes[1].offset_ms, 65_000);
        assert_eq!(from_scratch.notes[2].offset_ms, 65_000);

        // Same answer when the anchor was already delivered by an earlier poll.
        let after_anchor = fixture.read(0, 2);
        assert_eq!(
            after_anchor.notes,
            vec![LiveNote {
                note: 3,
                offset_ms: 65_000,
                text: "after".into()
            }]
        );
    }
}

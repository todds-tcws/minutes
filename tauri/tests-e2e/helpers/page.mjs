import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTauriStub } from './tauri-stub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML_PATH = path.resolve(__dirname, '../../src/index.html');
export const INDEX_HTML_URL = `file://${INDEX_HTML_PATH}`;

/**
 * Loads index.html against file:// with window.__TAURI__ stubbed.
 *
 * `useClock` installs Playwright's fake clock before navigation so tests can
 * advance the live pane's real 1000ms setInterval deterministically (AC-1.3)
 * without a 1:1 real-time wait per test. Only the live pane's own
 * `cmd_live_view` polling is asserted on call count in this suite;
 * `cmd_capture_status` is also read by the app's pre-existing checkStatus()
 * watchdog, so tests drive it via setDefault (idempotent, re-readable any
 * number of times) rather than a consumed queue, matching how the two
 * independent pollers would agree on shared backend state for real.
 */
/**
 * install() alone leaves the clock running in real time; pauseAt is what
 * actually freezes it so only explicit fastForward/runFor calls move it.
 * pauseAt(0) races the real milliseconds that elapse between the two calls
 * and intermittently throws "Cannot fast-forward to the past", so pause a
 * minute past the install epoch instead. Nothing has been navigated yet, so
 * no page timer fires, and every test asserts relative fastForward deltas.
 */
async function installPausedClock(page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
}

export async function openIndex(page, { useClock = true } = {}) {
  if (useClock) {
    await installPausedClock(page);
  }
  await installTauriStub(page);
  await page.goto(INDEX_HTML_URL);
  await page.waitForSelector('#live-pane', { state: 'attached' });
}

export function liveViewPage({ lines = [], totalLines, notes = [], totalNotes } = {}) {
  return {
    lines,
    total_lines: totalLines ?? lines.reduce((max, l) => Math.max(max, l.line), 0),
    notes,
    total_notes: totalNotes ?? notes.reduce((max, n) => Math.max(max, n.note), 0),
  };
}

/**
 * Minimum cmd_get_settings shape that loadSettings() (index.html) can walk
 * without throwing — several sections are read unconditionally (no `?.`/`||`
 * guard around the parent object): transcription, diarization, summarization,
 * screen_context, assistant. Everything else in loadSettings is optional-
 * chained or `if`-guarded, so it's fine to omit here.
 */
export function settingsFixture(overrides = {}) {
  return {
    config_path: '/tmp/minutes-test-config.toml',
    transcription: { engine: 'whisper', model: 'base' },
    diarization: { engine: 'auto' },
    summarization: { engine: 'claude' },
    screen_context: { enabled: false, interval_secs: 30 },
    assistant: { agent: 'claude', agent_args: [] },
    call_detection: {
      enabled: true,
      poll_interval_secs: 1,
      cooldown_minutes: 5,
      google_meet_enabled: false,
      teams_web_enabled: false,
      stop_when_call_ends: false,
      any_mic_app: true,
      call_end_stop_countdown_secs: 30,
      prompt_card: true,
      ignored_apps: [],
    },
    ...overrides,
  };
}

export function captureStatus({ recording = false, processing = false, paused = false, diagnostic = '' } = {}) {
  return {
    recording,
    processing,
    paused,
    liveTranscript: { diagnostic },
  };
}

/**
 * Opens index.html, seeds cmd_get_settings, opens the Settings overlay and
 * switches to the "AI & Privacy" tab, which holds the Call Detection section
 * (id="tab-ai" / "panel-ai" — Call Detection is not on its own tab).
 */
export async function openCallDetectionSettings(page, { setDefault, settings }) {
  await openIndex(page, { useClock: false });
  await setDefault(page, 'cmd_get_settings', settings);
  await page.locator('#btn-settings').click();
  await page.locator('#tab-ai').click();
  await page.waitForSelector('#settings-call-detection-prompt-card', { state: 'visible' });
}

export const MEETING_DETECTED_HTML_PATH = path.resolve(__dirname, '../../src/meeting-detected.html');
export const MEETING_DETECTED_HTML_URL = `file://${MEETING_DETECTED_HTML_PATH}`;

export function meetingDetectedPayload({ appName = 'Microsoft Teams', processName = 'Teams', calendarTitle = null } = {}) {
  return { appName, processName, calendarTitle };
}

/**
 * Loads meeting-detected.html against file:// with window.__TAURI__ stubbed
 * and `cmd_get_meeting_detected` preset via an init script — the page reads
 * its payload synchronously on load, before a test gets a chance to call
 * setDefault/queueInvoke after goto(), so the response has to be seeded
 * before navigation (spec section 5(b)).
 */
export async function openMeetingDetected(page, { token = 1, payload, dismissMs, useClock = false } = {}) {
  if (useClock) {
    await installPausedClock(page);
  }
  await installTauriStub(page);
  await page.addInitScript((p) => {
    window.__testState.defaults['cmd_get_meeting_detected'] = p;
  }, payload ?? meetingDetectedPayload());

  const query = new URLSearchParams({ t: String(token) });
  if (dismissMs !== undefined) query.set('dismiss_ms', String(dismissMs));
  await page.goto(`${MEETING_DETECTED_HTML_URL}?${query.toString()}`);
  await page.waitForSelector('#record-btn', { state: 'attached' });
}

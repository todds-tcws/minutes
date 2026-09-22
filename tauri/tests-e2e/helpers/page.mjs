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
export async function openIndex(page, { useClock = true } = {}) {
  if (useClock) {
    await page.clock.install({ time: 0 });
    // install() alone leaves the clock running in real time; pauseAt is what
    // actually freezes it so only explicit fastForward/runFor calls move it.
    await page.clock.pauseAt(0);
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

export function captureStatus({ recording = false, processing = false, paused = false, diagnostic = '' } = {}) {
  return {
    recording,
    processing,
    paused,
    liveTranscript: { diagnostic },
  };
}

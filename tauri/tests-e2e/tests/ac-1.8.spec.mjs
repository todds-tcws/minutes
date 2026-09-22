// AC-1.8: recording->stopped+processing->idle->recording again lifecycle.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault } from '../helpers/tauri-stub.mjs';

test('stops polling cmd_live_view, keeps rows, shows the processing header, then hides and resets', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_live_view', liveViewPage({ lines: [{ line: 1, offset_ms: 1000, text: 'hi' }] }));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane')).toHaveClass(/active/);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1);
  const liveViewCallsWhileRecording = await page.evaluate(() => window.__testState.calls.cmd_live_view || 0);

  // recording -> false, processing -> true
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: false, processing: true }));
  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane')).toHaveClass(/active/);
  await expect(page.locator('#live-pane-banner')).toHaveText('Recording stopped · processing…');
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1); // rows kept

  await page.clock.fastForward(1000);
  const liveViewCallsWhileStopped = await page.evaluate(() => window.__testState.calls.cmd_live_view || 0);
  expect(liveViewCallsWhileStopped).toBe(liveViewCallsWhileRecording); // cmd_live_view polling stopped

  // processing -> false: hide pane, return to idle
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: false, processing: false }));
  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane')).not.toHaveClass(/active/);

  // a new recording starts: pane shown again, cleared (this session's file
  // starts fresh, so this poll's own page is empty too)
  await setDefault(page, 'cmd_live_view', liveViewPage({}));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane')).toHaveClass(/active/);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(0);
});

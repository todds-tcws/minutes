// AC-1.11: more than 2000 rows trims the DOM down to 2000; cursors are unaffected.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault, callLog } from '../helpers/tauri-stub.mjs';

test('a 2100-line page settles at 2000 rendered rows', async ({ page }) => {
  await openIndex(page, { useClock: true });
  const lines = Array.from({ length: 2100 }, (_, i) => ({
    line: i + 1,
    offset_ms: (i + 1) * 100,
    text: `l${i + 1}`,
  }));
  await setDefault(page, 'cmd_live_view', liveViewPage({ lines }));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2000);

  // The oldest 100 rows (lines 1-100) were dropped; line 101 is now the first row.
  await expect(page.locator('#live-pane-list .live-pane-row').first()).toContainText('l101');

  // Cursors track line numbers, not DOM rows, so the next poll asks for line > 2100.
  await page.clock.fastForward(1000);
  const calls = await callLog(page, 'cmd_live_view');
  expect(calls[1].args).toEqual({ afterLine: 2100, afterNote: 0 });
});

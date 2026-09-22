// AC-1.6: a paused->true edge inserts a "Paused" marker row; repeated pauses repeat it.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault } from '../helpers/tauri-stub.mjs';

test('toggling paused twice inserts two marker rows', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_live_view', liveViewPage({}));

  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, paused: false }));
  await page.clock.fastForward(1000);
  await expect(page.locator('.live-pane-row--marker')).toHaveCount(0);

  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, paused: true }));
  await page.clock.fastForward(1000);
  await expect(page.locator('.live-pane-row--marker')).toHaveCount(1);

  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, paused: false }));
  await page.clock.fastForward(1000);
  await expect(page.locator('.live-pane-row--marker')).toHaveCount(1);

  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, paused: true }));
  await page.clock.fastForward(1000);
  await expect(page.locator('.live-pane-row--marker')).toHaveCount(2);
});

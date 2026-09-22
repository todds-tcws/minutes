// AC-1.14: a cmd_live_view rejection keeps rendered rows, keeps polling, and shows
// "Live view unavailable" until the next success clears it.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault, queueInvoke, resolve, reject } from '../helpers/tauri-stub.mjs';

test('a rejected poll keeps rows, keeps polling, and shows the unavailable text until the next success', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await queueInvoke(page, 'cmd_live_view', [
    resolve(liveViewPage({ lines: [{ line: 1, offset_ms: 1000, text: 'kept row' }] })),
    reject('backend unreachable'),
    resolve(liveViewPage({ lines: [{ line: 2, offset_ms: 2000, text: 'second row' }], totalLines: 2 })),
  ]);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1);
  await expect(page.locator('#live-pane-diagnostic')).toBeHidden();

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1); // kept
  await expect(page.locator('#live-pane-diagnostic')).toHaveText('Live view unavailable');

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2); // polling continued
  await expect(page.locator('#live-pane-diagnostic')).toBeHidden(); // cleared
});

// AC-1.5: near-bottom auto-scroll; scrolled-up preserves position and shows "Jump to latest".
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault, queueInvoke, resolve } from '../helpers/tauri-stub.mjs';

function manyLines(start, count, offsetStep = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    line: start + i,
    offset_ms: (start + i) * offsetStep,
    text: `line number ${start + i} has enough text in it to take up real width`,
  }));
}

test('scrolling up before an append keeps scrollTop and shows Jump to latest; clicking it returns to bottom', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await queueInvoke(page, 'cmd_live_view', [
    resolve(liveViewPage({ lines: manyLines(1, 60) })),
    resolve(liveViewPage({ lines: manyLines(61, 1), totalLines: 61 })),
  ]);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(60);

  const list = page.locator('#live-pane-list');
  await list.evaluate((el) => { el.scrollTop = 0; });
  const scrollTopBefore = await list.evaluate((el) => el.scrollTop);
  expect(scrollTopBefore).toBe(0);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(61);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(page.locator('#live-pane-jump')).toBeVisible();

  // DOM .click() rather than a simulated pointer click — an unrelated
  // first-run onboarding overlay (its own completion state isn't part of
  // this stub) can sit on top at this viewport, and occlusion by it isn't
  // what this AC is testing.
  await page.locator('#live-pane-jump').evaluate((el) => el.click());
  await expect(page.locator('#live-pane-jump')).toBeHidden();
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
});

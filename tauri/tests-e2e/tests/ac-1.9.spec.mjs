// AC-1.9: at the 460x520 minimum viewport, recording bar controls stay fully
// visible and only the pane scrolls internally.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault } from '../helpers/tauri-stub.mjs';

test.use({ viewport: { width: 460, height: 520 } });

test('recording bar controls stay inside the viewport with no page scroll; pane scrolls internally', async ({ page }, testInfo) => {
  await openIndex(page, { useClock: true });
  const manyLines = Array.from({ length: 40 }, (_, i) => ({
    line: i + 1,
    offset_ms: (i + 1) * 1000,
    text: `transcript line ${i + 1} with some representative width of text`,
  }));
  await setDefault(page, 'cmd_live_view', liveViewPage({ lines: manyLines }));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  // 2000ms so both the live pane's own 1000ms tick and the app's pre-existing
  // checkStatus() 2000ms watchdog (which flips #recording-bar to .active) run.
  await page.clock.fastForward(2000);
  await expect(page.locator('#recording-bar')).toHaveClass(/active/);
  await expect(page.locator('#live-pane-list .live-pane-row')).not.toHaveCount(0);

  // Below 720px the list pane auto-collapses and `visibility: hidden`s every
  // child of .app-left. A live recording must hold it open, otherwise the
  // geometry below is measured on unpainted controls.
  await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('#live-pane')).toBeVisible();

  const viewport = { width: 460, height: 520 };
  for (const id of ['btn-coach-recording', 'btn-note-inline', 'btn-stop']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box, `#${id} should be visible/measurable`).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
  }

  const noPageScroll = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el.scrollHeight <= el.clientHeight;
  });
  expect(noPageScroll).toBe(true);

  await testInfo.attach('recording-bar-460x520', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('the list pane collapses again once the recording ends and the pane hides', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_live_view', liveViewPage({}));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await page.clock.fastForward(1000);
  await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);

  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: false, processing: false }));
  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane')).not.toHaveClass(/active/);
  await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
});

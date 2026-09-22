// AC-1.3: 1000ms poll period, rows appear promptly, append-only ordering.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault, queueInvoke, resolve, callCount } from '../helpers/tauri-stub.mjs';

test.describe('AC-1.3', () => {
  test('polls cmd_live_view every 1000ms while recording, via a stub clock', async ({ page }) => {
    await openIndex(page, { useClock: true });
    await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
    await setDefault(page, 'cmd_live_view', liveViewPage({}));

    expect(await callCount(page, 'cmd_live_view')).toBe(0);

    await page.clock.fastForward(500);
    expect(await callCount(page, 'cmd_live_view')).toBe(0);

    await page.clock.fastForward(500); // total 1000ms
    await expect.poll(() => callCount(page, 'cmd_live_view')).toBe(1);

    await page.clock.fastForward(1000); // total 2000ms
    await expect.poll(() => callCount(page, 'cmd_live_view')).toBe(2);

    await page.clock.fastForward(1000); // total 3000ms
    await expect.poll(() => callCount(page, 'cmd_live_view')).toBe(3);
  });

  test('renders new rows promptly after the stubbed invoke resolves', async ({ page }) => {
    await openIndex(page, { useClock: false });
    await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
    await queueInvoke(page, 'cmd_live_view', [
      resolve(liveViewPage({ lines: [{ line: 1, offset_ms: 1000, text: 'hello there' }] })),
    ]);

    const timing = await page.evaluate(() => new Promise((done) => {
      const list = document.getElementById('live-pane-list');
      const observer = new MutationObserver(() => {
        const row = list.querySelector('.live-pane-row--line');
        if (!row) return;
        observer.disconnect();
        const call = window.__testState.callLog.find((c) => c.cmd === 'cmd_live_view');
        done({ calledAt: call ? call.t : null, observedAt: Date.now() });
      });
      observer.observe(list, { childList: true });
    }));

    expect(timing.calledAt).not.toBeNull();
    expect(timing.observedAt - timing.calledAt).toBeLessThan(200);
    await expect(page.locator('.live-pane-row--line')).toHaveText('0:01hello there');
  });

  test('stable-sorts a page by offset_ms and appends after the last row', async ({ page }) => {
    await openIndex(page, { useClock: false });
    await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
    // Raw array order deliberately does not match offset order: the note
    // (offset 1500) sits between two transcript lines (1000, 2000) but is
    // listed last in the response.
    await queueInvoke(page, 'cmd_live_view', [
      resolve(liveViewPage({
        lines: [
          { line: 1, offset_ms: 1000, text: 'first line' },
          { line: 2, offset_ms: 2000, text: 'second line' },
        ],
        notes: [{ note: 1, offset_ms: 1500, text: 'a note' }],
      })),
    ]);

    await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(3);
    const kinds = await page.locator('#live-pane-list .live-pane-row').evaluateAll(
      (rows) => rows.map((r) => (r.classList.contains('live-pane-row--note') ? 'note' : 'line')),
    );
    expect(kinds).toEqual(['line', 'note', 'line']);
  });

  test('a later page whose note has an earlier offset is still appended after, never inserted', async ({ page }) => {
    await openIndex(page, { useClock: true });
    await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
    await queueInvoke(page, 'cmd_live_view', [
      resolve(liveViewPage({ lines: [{ line: 1, offset_ms: 5000, text: 'late line' }] })),
      resolve(liveViewPage({
        lines: [],
        totalLines: 1,
        notes: [{ note: 1, offset_ms: 1000, text: 'early note' }],
      })),
    ]);

    await page.clock.fastForward(1000);
    await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1);

    await page.clock.fastForward(1000);
    await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2);
    const kinds = await page.locator('#live-pane-list .live-pane-row').evaluateAll(
      (rows) => rows.map((r) => (r.classList.contains('live-pane-row--note') ? 'note' : 'line')),
    );
    expect(kinds).toEqual(['line', 'note']);
  });
});

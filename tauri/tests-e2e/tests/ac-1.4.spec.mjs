// AC-1.4: a shrinking total_lines/total_notes resets cursors and clears the pane.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault, queueInvoke, resolve, callLog } from '../helpers/tauri-stub.mjs';

test('a poll with a smaller total_lines resets both cursors to 0 and clears the pane', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await queueInvoke(page, 'cmd_live_view', [
    resolve(liveViewPage({
      lines: [
        { line: 1, offset_ms: 1000, text: 'a' },
        { line: 2, offset_ms: 2000, text: 'b' },
      ],
      totalLines: 100, // simulates a much longer file than what this page returned
    })),
    // File rotated (new recording, or torn/replaced file): total_lines now
    // smaller than the cursor (2) we already advanced past.
    resolve(liveViewPage({ lines: [], totalLines: 1, notes: [], totalNotes: 0 })),
    resolve(liveViewPage({ lines: [{ line: 1, offset_ms: 500, text: 'fresh' }], totalLines: 1 })),
  ]);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(0);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(1);

  const calls = await callLog(page, 'cmd_live_view');
  expect(calls[2].args).toEqual({ afterLine: 0, afterNote: 0 });
});

test('a shrinking page that also carries rows is discarded, and the next poll re-reads both sources from zero', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true }));
  await queueInvoke(page, 'cmd_live_view', [
    resolve(liveViewPage({
      lines: [{ line: 3, offset_ms: 3000, text: 'c' }],
      totalLines: 3,
      notes: [{ note: 100, offset_ms: 2500, text: 'old note' }],
      totalNotes: 100,
    })),
    // Transcript rotated (total 2 < cursor 3) while a note 101 arrives in the
    // same page. That page was filtered by the OLD cursors, so it lacks notes
    // 1..100 of the new session: it must be dropped, not applied.
    resolve(liveViewPage({
      lines: [],
      totalLines: 2,
      notes: [{ note: 101, offset_ms: 100, text: 'stale delta' }],
      totalNotes: 101,
    })),
    resolve(liveViewPage({
      lines: [{ line: 1, offset_ms: 500, text: 'fresh' }],
      totalLines: 1,
      notes: [{ note: 1, offset_ms: 200, text: 'fresh note' }],
      totalNotes: 1,
    })),
  ]);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2);

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(0);
  await expect(page.locator('#live-pane-list')).not.toContainText('stale delta');

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-list .live-pane-row')).toHaveCount(2);

  const calls = await callLog(page, 'cmd_live_view');
  expect(calls[2].args).toEqual({ afterLine: 0, afterNote: 0 });
});

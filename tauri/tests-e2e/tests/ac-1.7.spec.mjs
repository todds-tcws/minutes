// AC-1.7: an empty pane shows the current diagnostic, or "Waiting for speech…" when it's empty.
import { test, expect } from '@playwright/test';
import { openIndex, liveViewPage, captureStatus } from '../helpers/page.mjs';
import { setDefault } from '../helpers/tauri-stub.mjs';

test('shows the live diagnostic text in place of the empty list', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_live_view', liveViewPage({}));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, diagnostic: 'Mic detected, no speech yet' }));

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-diagnostic')).toHaveText('Mic detected, no speech yet');
});

test('falls back to "Waiting for speech…" when the diagnostic is empty', async ({ page }) => {
  await openIndex(page, { useClock: true });
  await setDefault(page, 'cmd_live_view', liveViewPage({}));
  await setDefault(page, 'cmd_capture_status', captureStatus({ recording: true, diagnostic: '' }));

  await page.clock.fastForward(1000);
  await expect(page.locator('#live-pane-diagnostic')).toHaveText('Waiting for speech…');
});

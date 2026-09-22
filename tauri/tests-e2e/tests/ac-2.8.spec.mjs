// AC-2.8: Not now click, and the dismiss_ms-overridable auto-dismiss timer,
// both close the card via the "not_now" choice (the this-call add itself is
// core-side, covered by the Rust unit tests on CallPromptState).
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { callCount, callLog, queueInvoke, reject } from '../helpers/tauri-stub.mjs';

test('Not now click invokes cmd_meeting_detected_choice with "not_now"', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload() });

  await page.locator('#not-now-btn').click();

  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
  const log = await callLog(page, 'cmd_meeting_detected_choice');
  expect(log[0].args).toEqual({ choice: 'not_now' });
});

test('the dismiss_ms auto-dismiss timer closes the card as "not_now"', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, dismissMs: 500, payload: meetingDetectedPayload() });

  await page.clock.fastForward(500);

  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
  const log = await callLog(page, 'cmd_meeting_detected_choice');
  expect(log[0].args).toEqual({ choice: 'not_now' });
});

test('the default 20000ms auto-dismiss does not fire before 20000ms and fires at 20000ms', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, payload: meetingDetectedPayload() });

  await page.clock.fastForward(19999);
  expect(await callCount(page, 'cmd_meeting_detected_choice')).toBe(0);

  await page.clock.fastForward(1);
  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
  const log2 = await callLog(page, 'cmd_meeting_detected_choice');
  expect(log2[0].args).toEqual({ choice: 'not_now' });
});

test('a rejected cmd_meeting_detected_choice still closes the card via cmd_close_meeting_detected', async ({ page }) => {
  // Without a fallback, a rejected choice (ledger write failure, config
  // save failure, unknown choice) leaves an always-on-top, undecorated,
  // non-focusable card the user cannot dismiss by any means.
  await openMeetingDetected(page, { payload: meetingDetectedPayload() });
  await queueInvoke(page, 'cmd_meeting_detected_choice', [reject('ledger write failed')]);

  await page.locator('#not-now-btn').click();

  await expect.poll(() => callCount(page, 'cmd_close_meeting_detected')).toBe(1);
});

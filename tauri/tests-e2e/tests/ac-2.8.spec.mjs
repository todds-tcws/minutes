// AC-2.8: Not now click, and the dismiss_ms-overridable auto-dismiss timer,
// both close the card via the "not_now" choice (the this-call add itself is
// core-side, covered by the Rust unit tests on CallPromptState).
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { callCount, callLog } from '../helpers/tauri-stub.mjs';

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

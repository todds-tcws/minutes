// AC-2.7: Record failure keeps the card open with an error, replacing the
// button row, then closes as Not now after the 5000 ms hold. Whichever of
// the error hold or the auto-dismiss timer fires first wins and the other
// is a no-op — covered here by a dismiss_ms shorter than the hold.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { queueInvoke, reject, resolve, callCount, callLog } from '../helpers/tauri-stub.mjs';

test('a rejected cmd_start_recording keeps the card open with error text, then closes after the hold', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, payload: meetingDetectedPayload() });
  await queueInvoke(page, 'cmd_start_recording', [reject('mic busy')]);

  await page.locator('#record-btn').click();

  await expect(page.locator('#error-row')).toBeVisible();
  await expect(page.locator('#error-text')).toHaveText("Couldn't start recording Error: mic busy");
  await expect(page.locator('#actions-primary')).toBeHidden();
  expect(await callCount(page, 'cmd_meeting_detected_choice')).toBe(0);

  // Boundary: the 5000ms error hold has not elapsed yet.
  await page.clock.fastForward(4999);
  expect(await callCount(page, 'cmd_meeting_detected_choice')).toBe(0);

  await page.clock.fastForward(1);
  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
  const log = await callLog(page, 'cmd_meeting_detected_choice');
  expect(log[0].args).toEqual({ choice: 'not_now' });
});

test('a resolved cmd_start_recording sends the exact call_detect args and closes the card as "record"', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload() });
  await queueInvoke(page, 'cmd_start_recording', [resolve({})]);

  await page.locator('#record-btn').click();

  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
  // Exact args, no title key — AC-2.7's "no title argument, intent Call via
  // source: 'call_detect'" contract; a rename or typo here ships silently
  // broken otherwise.
  expect((await callLog(page, 'cmd_start_recording'))[0].args).toEqual({ intent: 'call', source: 'call_detect' });
  expect((await callLog(page, 'cmd_meeting_detected_choice'))[0].args).toEqual({ choice: 'record' });
});

test('a dismiss_ms shorter than the 5000 ms error hold still closes exactly once', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, dismissMs: 500, payload: meetingDetectedPayload() });
  await queueInvoke(page, 'cmd_start_recording', [reject('mic busy')]);

  await page.locator('#record-btn').click();
  await expect(page.locator('#error-row')).toBeVisible();

  // The 20s-normally auto-dismiss timer, shortened to 500ms here, fires
  // before the 5000ms error hold.
  await page.clock.fastForward(500);
  await expect.poll(() => callCount(page, 'cmd_meeting_detected_choice')).toBe(1);

  // The error hold would fire next (at 5000ms real elapsed); it must be a
  // no-op since the card already closed.
  await page.clock.fastForward(4600);
  expect(await callCount(page, 'cmd_meeting_detected_choice')).toBe(1);
});

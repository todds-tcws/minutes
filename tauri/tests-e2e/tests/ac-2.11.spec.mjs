// AC-2.11 (card half): the card polls cmd_capture_status every 1000ms, same
// as recording-hud.html, and closes itself (cmd_close_meeting_detected, no
// choice recorded) when a recording starts by any other means.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { setDefault, callCount } from '../helpers/tauri-stub.mjs';

test('the card closes itself when cmd_capture_status reports recording true', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, payload: meetingDetectedPayload() });
  await setDefault(page, 'cmd_capture_status', { recording: false });

  await page.clock.fastForward(1000);
  expect(await callCount(page, 'cmd_close_meeting_detected')).toBe(0);

  await setDefault(page, 'cmd_capture_status', { recording: true });
  await page.clock.fastForward(1000);

  await expect.poll(() => callCount(page, 'cmd_close_meeting_detected')).toBe(1);
  // No choice was recorded for this path — a recording started elsewhere,
  // not a card decision.
  expect(await callCount(page, 'cmd_meeting_detected_choice')).toBe(0);
});

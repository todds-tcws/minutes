// AC-2.11: card half (the card polls cmd_capture_status every 1000ms, same
// as recording-hud.html, and closes itself when a recording starts by any
// other means) plus settings half (turning call_detection.prompt_card off
// in Settings invokes cmd_close_meeting_detected immediately).
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload, openCallDetectionSettings, settingsFixture } from '../helpers/page.mjs';
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

test('cmd_capture_status polls immediately on open, then exactly every 1000ms', async ({ page }) => {
  await openMeetingDetected(page, { useClock: true, payload: meetingDetectedPayload() });
  await setDefault(page, 'cmd_capture_status', { recording: false });

  await expect.poll(() => callCount(page, 'cmd_capture_status')).toBe(1); // immediate poll on load

  await page.clock.fastForward(999);
  expect(await callCount(page, 'cmd_capture_status')).toBe(1);

  await page.clock.fastForward(1);
  expect(await callCount(page, 'cmd_capture_status')).toBe(2);
});

test('turning "Ask with a floating prompt" off invokes cmd_close_meeting_detected', async ({ page }) => {
  const settings = settingsFixture();
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('On');
  await page.locator('#settings-call-detection-prompt-card').click();

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
  await expect.poll(() => callCount(page, 'cmd_close_meeting_detected')).toBe(1);
});

test('turning "Ask with a floating prompt" on does not invoke cmd_close_meeting_detected', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, prompt_card: false },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
  await page.locator('#settings-call-detection-prompt-card').click();

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('On');
  expect(await callCount(page, 'cmd_close_meeting_detected')).toBe(0);
});

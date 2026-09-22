// AC-2.9: the snooze control opens a menu with exactly three items, and each
// fires its matching cmd_meeting_detected_choice value.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { callLog } from '../helpers/tauri-stub.mjs';

test('the snooze control opens a menu with exactly three items', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Slack' }) });

  await expect(page.locator('#actions-menu')).toBeHidden();
  await page.locator('#snooze-btn').click();
  await expect(page.locator('#actions-menu')).toBeVisible();
  await expect(page.locator('#actions-menu [role="menuitem"]')).toHaveCount(3);
  await expect(page.locator('#menu-not-for-call')).toHaveText('Not for this call');
  await expect(page.locator('#menu-hour')).toHaveText('1 hour');
  await expect(page.locator('#menu-never')).toHaveText('Never for Slack');
});

const items = [
  { id: '#menu-not-for-call', choice: 'snooze_call' },
  { id: '#menu-hour', choice: 'snooze_hour' },
  { id: '#menu-never', choice: 'never' },
];

for (const { id, choice } of items) {
  test(`snooze menu item ${id} fires cmd_meeting_detected_choice("${choice}")`, async ({ page }) => {
    await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Slack' }) });
    await page.locator('#snooze-btn').click();
    await page.locator(id).click();

    const log = await callLog(page, 'cmd_meeting_detected_choice');
    expect(log).toHaveLength(1);
    expect(log[0].args).toEqual({ choice });
  });
}

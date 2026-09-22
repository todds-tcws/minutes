// AC-2.9: the chevron opens a menu holding Not now plus exactly three snooze
// items, and each snooze item fires its matching cmd_meeting_detected_choice.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';
import { callLog } from '../helpers/tauri-stub.mjs';

test('the chevron opens a menu with Not now and exactly three snooze items', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Slack' }) });

  await expect(page.locator('#actions-menu')).toBeHidden();
  await page.locator('#snooze-btn').click();
  await expect(page.locator('#actions-menu')).toBeVisible();
  await expect(page.locator('#actions-menu [role="menuitem"]')).toHaveCount(4);
  await expect(page.locator('#actions-menu [role="menuitem"]').first()).toHaveId('not-now-btn');
  await expect(page.locator('#not-now-btn')).toHaveText('Not now');
  await expect(page.locator('#snooze-btn')).toHaveAttribute('aria-expanded', 'true');
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

test('the open menu fits inside the 420x224 expanded window with a calendar title', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 224 });
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ calendarTitle: 'Weekly sync' }) });

  await expect(page.locator('#title-row')).toBeVisible();
  await page.locator('#snooze-btn').click();
  await expect(page.locator('#actions-menu')).toBeVisible();

  const overflowed = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth);
  expect(overflowed).toBe(false);
  for (const id of ['#not-now-btn', '#menu-not-for-call', '#menu-hour', '#menu-never']) {
    await expect(page.locator(id)).toBeInViewport();
  }
});

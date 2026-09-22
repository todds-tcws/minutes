// AC-2.3: base card state — one-row pill with heading, app name, the hint
// subtitle, the Record split button and its chevron (snooze control), and no
// calendar title when no event was supplied. Not now lives in the chevron menu.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';

test('base state renders heading, app name, hint, Record split button and chevron, with no title row', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Microsoft Teams' }) });

  await expect(page.locator('#heading')).toHaveText('In a meeting?');
  await expect(page.locator('#app-name')).toHaveText('Microsoft Teams');
  await expect(page.locator('#hint')).toHaveText('Recording stays on this Mac');
  await expect(page.locator('#hint-row')).toBeVisible();
  await expect(page.locator('#record-btn')).toBeVisible();
  await expect(page.locator('#record-btn')).toHaveText('Record');
  await expect(page.locator('#snooze-btn')).toBeVisible();
  await expect(page.locator('#snooze-btn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#actions-menu')).toBeHidden();
  await expect(page.locator('#not-now-btn')).toBeHidden();
  await expect(page.locator('#title-row')).toBeHidden();
  await expect(page.locator('.card .mark')).toBeVisible();
});

test('the pill fits the 420x64 rest window with no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 64 });
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Microsoft Teams', calendarTitle: 'A fairly long weekly leadership sync title' }) });
  const overflowed = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth);
  expect(overflowed).toBe(false);
  await expect(page.locator('#record-btn')).toBeInViewport();
  await expect(page.locator('#snooze-btn')).toBeInViewport();
});

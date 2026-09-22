// AC-2.3: base card state — heading, app name, Record/Not now buttons, the
// snooze control, and no title row when no calendar event was supplied.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';

test('base state renders heading, app name, Record/Not now, and the snooze control, with no title row', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload({ appName: 'Microsoft Teams' }) });

  await expect(page.locator('#heading')).toHaveText('In a meeting?');
  await expect(page.locator('#app-name')).toHaveText('Microsoft Teams');
  await expect(page.locator('#record-btn')).toBeVisible();
  await expect(page.locator('#record-btn')).toHaveText('Record');
  await expect(page.locator('#not-now-btn')).toBeVisible();
  await expect(page.locator('#not-now-btn')).toHaveText('Not now');
  await expect(page.locator('#snooze-btn')).toBeVisible();
  await expect(page.locator('#title-row')).toBeHidden();
});

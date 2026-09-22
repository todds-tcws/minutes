// AC-2.5: a calendar title that arrives late (after the page has loaded and
// registered its listener) fills in the title row; a title already present
// on the initial payload (arrived before the listener registered) renders
// without waiting for the event too.
import { test, expect } from '@playwright/test';
import { openMeetingDetected, meetingDetectedPayload } from '../helpers/page.mjs';

test('a late meeting-detected:calendar event fills in the title row', async ({ page }) => {
  await openMeetingDetected(page, { payload: meetingDetectedPayload() });

  await expect(page.locator('#title-row')).toBeHidden();
  await page.evaluate(() => window.__testEmit('meeting-detected:calendar', { title: 'Weekly sync' }));
  await expect(page.locator('#title-row')).toBeVisible();
  await expect(page.locator('#calendar-title')).toHaveText('Weekly sync');
});

test('a title already on the staged payload renders without an event', async ({ page }) => {
  await openMeetingDetected(page, {
    payload: meetingDetectedPayload({ calendarTitle: 'Already resolved sync' }),
  });

  await expect(page.locator('#title-row')).toBeVisible();
  await expect(page.locator('#calendar-title')).toHaveText('Already resolved sync');
});

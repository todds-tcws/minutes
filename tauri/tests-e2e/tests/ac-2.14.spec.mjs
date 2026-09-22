// AC-2.14: Settings > Call detection shows a toggle bound to
// call_detection.prompt_card and an "Ignored apps" list with one row per
// entry plus a remove control; removing a row saves the config without that
// app.
import { test, expect } from '@playwright/test';
import { openCallDetectionSettings, settingsFixture } from '../helpers/page.mjs';
import { setDefault, callLog } from '../helpers/tauri-stub.mjs';

test('the toggle reflects call_detection.prompt_card on load', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, prompt_card: false },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
});

test('ignored-apps empty state shows a hint and no rows', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, ignored_apps: [] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.locator('#settings-ignored-apps-list > *')).toHaveCount(0);
  await expect(page.locator('#settings-ignored-apps-empty')).toBeVisible();
});

test('ignored-apps with rows renders one row per entry with a Remove control, hint hidden', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Slack', 'Webex'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.locator('#settings-ignored-apps-list > *')).toHaveCount(2);
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Slack');
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Webex');
  await expect(page.locator('#settings-ignored-apps-list button', { hasText: 'Remove' })).toHaveCount(2);
  await expect(page.locator('#settings-ignored-apps-empty')).toBeHidden();
});

test('removing a row saves the config without that app and re-renders without it', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Slack', 'Webex'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await page.locator('#settings-ignored-apps-list .about-controls', { hasText: 'Slack' })
    .locator('button', { hasText: 'Remove' })
    .click();

  const log = await callLog(page, 'cmd_set_setting');
  expect(log).toHaveLength(1);
  expect(log[0].args).toEqual({ section: 'call_detection', key: 'ignored_apps', value: 'Webex' });

  await expect(page.locator('#settings-ignored-apps-list')).not.toContainText('Slack');
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Webex');
  await expect(page.locator('#settings-ignored-apps-list > *')).toHaveCount(1);
});

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
  // JSON, not comma-join: see the regression test below for why.
  expect(log[0].args).toEqual({ section: 'call_detection', key: 'ignored_apps', value: JSON.stringify(['Webex']) });

  await expect(page.locator('#settings-ignored-apps-list')).not.toContainText('Slack');
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Webex');
  await expect(page.locator('#settings-ignored-apps-list > *')).toHaveCount(1);
});

test('removing one ignored app preserves a remaining app name containing a comma (JSON, not comma-join)', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Zoom, Inc', 'Webex'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await page.locator('#settings-ignored-apps-list .about-controls', { hasText: 'Webex' })
    .locator('button', { hasText: 'Remove' })
    .click();

  const log = await callLog(page, 'cmd_set_setting');
  expect(log).toHaveLength(1);
  expect(log[0].args).toEqual({ section: 'call_detection', key: 'ignored_apps', value: JSON.stringify(['Zoom, Inc']) });
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Zoom, Inc');
});

test('the Remove button has a name-specific accessible label', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Slack', 'Webex'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });

  await expect(page.getByRole('button', { name: 'Remove Slack' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Webex' })).toBeVisible();
});

test('the prompt_card toggle and ignored-apps list reflect the persisted value after Settings is reopened', async ({ page }) => {
  const settings = settingsFixture({
    call_detection: { ...settingsFixture().call_detection, prompt_card: true, ignored_apps: ['Slack'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });
  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('On');

  await page.locator('#settings-call-detection-prompt-card').click();
  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
  await page.locator('#btn-settings-close').click();

  // Simulate the write that just happened having persisted: the next
  // cmd_get_settings the reopened panel fetches reflects it.
  await setDefault(page, 'cmd_get_settings', settingsFixture({
    call_detection: { ...settingsFixture().call_detection, prompt_card: false, ignored_apps: ['Slack'] },
  }));
  await page.locator('#btn-settings').click();
  await page.locator('#tab-ai').click();
  await page.waitForSelector('#settings-call-detection-prompt-card', { state: 'visible' });

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Slack');
});

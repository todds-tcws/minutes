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
    call_detection: { ...settingsFixture().call_detection, prompt_card: true, ignored_apps: ['Slack', 'Webex'] },
  });
  await openCallDetectionSettings(page, { setDefault, settings });
  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('On');

  await page.locator('#settings-call-detection-prompt-card').click();
  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');

  await page.locator('#settings-ignored-apps-list .about-controls', { hasText: 'Slack' })
    .locator('button', { hasText: 'Remove' })
    .click();

  // Derive the "persisted" state from the writes the handlers actually made
  // — not hand-fed — so this fails if reload-on-open regresses to stale DOM.
  const log = await callLog(page, 'cmd_set_setting');
  const toggleWrite = log.find((c) => c.args.key === 'prompt_card');
  const ignoredWrite = log.find((c) => c.args.key === 'ignored_apps');
  expect(toggleWrite.args).toEqual({ section: 'call_detection', key: 'prompt_card', value: 'false' });
  expect(ignoredWrite.args).toEqual({ section: 'call_detection', key: 'ignored_apps', value: JSON.stringify(['Webex']) });

  await page.locator('#btn-settings-close').click();

  await setDefault(page, 'cmd_get_settings', settingsFixture({
    call_detection: {
      ...settingsFixture().call_detection,
      prompt_card: toggleWrite.args.value === 'true',
      ignored_apps: JSON.parse(ignoredWrite.args.value),
    },
  }));
  await page.locator('#btn-settings').click();
  await page.locator('#tab-ai').click();
  await page.waitForSelector('#settings-call-detection-prompt-card', { state: 'visible' });

  await expect(page.locator('#settings-call-detection-prompt-card')).toHaveText('Off');
  await expect(page.locator('#settings-ignored-apps-list')).toContainText('Webex');
  await expect(page.locator('#settings-ignored-apps-list')).not.toContainText('Slack');
});

test('removing an ignored app moves focus to the next Remove button, then to the empty note', async ({ page }) => {
  await openCallDetectionSettings(page, {
    setDefault,
    settings: settingsFixture({ call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Slack', 'Webex'] } }),
  });
  await setDefault(page, 'cmd_set_setting', {});
  const list = page.locator('#settings-ignored-apps-list');
  await expect(list.locator('button')).toHaveCount(2);

  // The stub returns the same settings for every cmd_get_settings call, so
  // hand it the post-removal state before each click.
  await setDefault(page, 'cmd_get_settings', settingsFixture({ call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Slack', 'Webex'] } }));
  await list.locator('button', { hasText: 'Remove' }).first().focus();
  await list.locator('button', { hasText: 'Remove' }).first().click();
  await expect(list.locator('button')).toHaveCount(1);
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Remove Webex');

  await setDefault(page, 'cmd_get_settings', settingsFixture({ call_detection: { ...settingsFixture().call_detection, ignored_apps: ['Webex'] } }));
  await list.locator('button', { hasText: 'Remove' }).first().click();
  await expect(list.locator('button')).toHaveCount(0);
  await expect(page.locator(':focus')).toHaveId('settings-ignored-apps-empty');
});

test('an Off toggle label is dimmed with a class that keeps 4.5:1 contrast, not with opacity', async ({ page }) => {
  await openCallDetectionSettings(page, {
    setDefault,
    settings: settingsFixture({ call_detection: { ...settingsFixture().call_detection, prompt_card: false } }),
  });
  const toggle = page.locator('#settings-call-detection-prompt-card');
  await expect(toggle).toHaveText('Off');
  await expect(toggle).toHaveClass(/is-off/);
  const ratio = await toggle.evaluate((el) => {
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const parse = (raw) => raw.match(/rgba?\(([^)]+)\)/)[1].split(',').slice(0, 3).map(Number);
    const fg = parse(getComputedStyle(el).color);
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim();
    document.body.appendChild(probe);
    const bg = parse(getComputedStyle(probe).color);
    probe.remove();
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(parseFloat(await toggle.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

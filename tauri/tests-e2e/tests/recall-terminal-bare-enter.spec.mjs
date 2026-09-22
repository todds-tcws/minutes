// Assistant panel privacy gate: a bare Enter (no question typed) must reach
// the agent's PTY so its own prompts (Claude Code folder trust, menus) can be
// answered, and must not trigger a meeting-context read.
import { test, expect } from '@playwright/test';
import { openIndex } from '../helpers/page.mjs';
import { callLog } from '../helpers/tauri-stub.mjs';

test('a bare Enter while context is pending is forwarded and reads no meeting context', async ({ page }) => {
  await openIndex(page, { useClock: false });
  await page.evaluate(async () => {
    recallTerminalContextPending = true;
    recallTerminalInputDraft = '';
    recallTerminalInputReliable = true;
    await forwardRecallTerminalInput('\r');
  });
  const pty = await callLog(page, 'cmd_pty_input');
  expect(pty.map((c) => c.args.data)).toEqual(['\r']);
  expect(await callLog(page, 'cmd_prepare_recall_terminal_meeting')).toEqual([]);
  expect(await page.evaluate(() => recallTerminalContextPending)).toBe(true);
});

test('Enter after cursor-edited text is still blocked while context is pending', async ({ page }) => {
  await openIndex(page, { useClock: false });
  await page.evaluate(async () => {
    recallTerminalContextPending = true;
    recallTerminalInputDraft = 'what did we decide';
    recallTerminalInputReliable = false;
    await forwardRecallTerminalInput('\r');
  });
  expect(await callLog(page, 'cmd_pty_input')).toEqual([]);
  expect(await callLog(page, 'cmd_prepare_recall_terminal_meeting')).toEqual([]);
});

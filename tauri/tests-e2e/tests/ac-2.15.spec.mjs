// AC-2.15: every new meeting-detected card string and settings string has a
// key in both locale catalogs. Evidence is key-presence only (spec section
// 2/6) — no rendered-translation check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '../../src/locales');

const KEYS = [
  // Card strings
  'In a meeting?',
  'Record',
  'Not now',
  'Snooze',
  'Not for this call',
  '1 hour',
  'Never for {app}',
  'Recording stays on this Mac',
  // Settings strings
  'Ask with a floating prompt',
  'Ignored apps',
  'Remove',
];

for (const locale of ['zh-CN', 'pt-BR']) {
  test(`${locale}.js has a key for every new card/settings string`, () => {
    const source = fs.readFileSync(path.join(LOCALES_DIR, `${locale}.js`), 'utf8');
    for (const key of KEYS) {
      expect(source.includes(JSON.stringify(key)), `missing key ${JSON.stringify(key)} in ${locale}.js`).toBe(true);
    }
    // "Remove {app}" is the ignored-apps row's accessible name (aria-label),
    // built dynamically — covered by a pattern rule, not an exact key.
    expect(source.includes('"^Remove (.+)$"'), `missing "Remove {app}" pattern rule in ${locale}.js`).toBe(true);
  });
}

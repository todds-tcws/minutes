// AC-1.10: every new live-pane string has a key in both locale catalogs.
// Evidence is key-presence only (spec section 2/6) — no rendered-translation check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '../../src/locales');

const KEYS = [
  'Note',
  'Paused',
  'Jump to latest',
  'Waiting for speech…',
  'Recording stopped · processing…',
  'Live view unavailable',
];

for (const locale of ['zh-CN', 'pt-BR']) {
  test(`${locale}.js has a key for every new live-pane string`, () => {
    const source = fs.readFileSync(path.join(LOCALES_DIR, `${locale}.js`), 'utf8');
    for (const key of KEYS) {
      expect(source.includes(JSON.stringify(key)), `missing key ${JSON.stringify(key)} in ${locale}.js`).toBe(true);
    }
  });
}

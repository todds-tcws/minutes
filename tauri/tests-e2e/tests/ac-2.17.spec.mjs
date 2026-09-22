// AC-2.17: the branch diff adds no new network client usage.
//
// Spec evidence command (section 3, AC-2.17):
//   git diff feat/notion-parity...HEAD | grep -E '^\+.*(ureq|reqwest|hyper|TcpStream|fetch\(|XMLHttpRequest|WebSocket|sendBeacon)'
//
// Run verbatim it is self-triggering: the spec and the task list are part of
// the diff and they quote the pattern. So this runs it twice — once over code
// (asserting empty) and once over everything (asserting every hit is one of
// the prose files that quotes the pattern), which proves the exclusion hides
// nothing.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = process.env.MINUTES_DIFF_BASE ?? 'feat/notion-parity';
const CLIENTS = /(ureq|reqwest|hyper|TcpStream|fetch\(|XMLHttpRequest|WebSocket|sendBeacon)/;

// Prose that quotes the pattern rather than using it: the spec, the task list,
// and this test.
const QUOTES_THE_PATTERN = [
  'project-specs/',
  'project-tasks/',
  'tauri/tests-e2e/tests/ac-2.17.spec.mjs',
];

/** Added lines in the branch diff, as [file, line] pairs. */
function addedLines() {
  const diff = execFileSync('git', ['diff', `${BASE}...HEAD`], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) out.push([file, line]);
  }
  return out;
}

test('the regex actually matches a network client line', () => {
  // Guards against a typo'd regex silently passing every other assertion.
  expect(CLIENTS.test('+    let res = ureq::get(url).call()?;')).toBe(true);
  expect(CLIENTS.test('+  const r = await fetch("https://x");')).toBe(true);
  expect(CLIENTS.test('+    let pane = document.createElement("div");')).toBe(false);
});

test('AC-2.17: no new network client usage in the branch diff', () => {
  const hits = addedLines().filter(([, line]) => CLIENTS.test(line));

  const inCode = hits.filter(([file]) => !QUOTES_THE_PATTERN.some((p) => file.startsWith(p)));
  expect(inCode.map(([file, line]) => `${file}: ${line}`)).toEqual([]);

  // Every hit the verbatim spec command reports is prose quoting the pattern.
  for (const [file] of hits) {
    expect(QUOTES_THE_PATTERN.some((p) => file.startsWith(p))).toBe(true);
  }
});

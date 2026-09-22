import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    headless: true,
    // Wide enough to stay clear of index.html's own SIDEBAR_AUTO_COLLAPSE_WIDTH
    // (720px, pre-existing/unrelated to this feature) so most tests see a
    // painted, not just laid-out, pane. AC-1.9 needs the literal 460x520
    // minimum and overrides this per-file.
    viewport: { width: 1000, height: 700 },
  },
});

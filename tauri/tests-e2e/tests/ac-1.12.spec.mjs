// AC-1.12: role="log", keyboard-scrollable, and >=3:1 accent-border contrast
// against the pane background in both color schemes.
import { test, expect } from '@playwright/test';
import { openIndex } from '../helpers/page.mjs';

test('the pane list is role="log" and tabindex="0"', async ({ page }) => {
  await openIndex(page, { useClock: false });
  const list = page.locator('#live-pane-list');
  await expect(list).toHaveAttribute('role', 'log');
  await expect(list).toHaveAttribute('tabindex', '0');
});

for (const colorScheme of ['light', 'dark']) {
  test(`the accent border meets 3:1 contrast against the pane background (${colorScheme})`, async ({ page }) => {
    await openIndex(page, { useClock: false });
    await page.emulateMedia({ colorScheme });

    const ratio = await page.evaluate(() => {
      function srgbToLinear(c) {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      }
      function relativeLuminance([r, g, b]) {
        const [rl, gl, bl] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
        return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
      }
      function parseColor(raw) {
        const str = raw.trim();
        const hex = str.match(/^#([0-9a-f]{6})$/i);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
        const rgb = str.match(/rgba?\(([^)]+)\)/);
        if (rgb) return rgb[1].split(',').slice(0, 3).map((n) => parseFloat(n));
        // Fall back to letting the browser resolve any other CSS color syntax.
        const probe = document.createElement('span');
        probe.style.color = str;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return parseColor(resolved);
      }
      const rootStyle = getComputedStyle(document.documentElement);
      const accent = parseColor(rootStyle.getPropertyValue('--accent'));
      const bg = parseColor(rootStyle.getPropertyValue('--bg'));
      const lAccent = relativeLuminance(accent);
      const lBg = relativeLuminance(bg);
      const [lighter, darker] = lAccent > lBg ? [lAccent, lBg] : [lBg, lAccent];
      return (lighter + 0.05) / (darker + 0.05);
    });

    expect(ratio).toBeGreaterThanOrEqual(3);
  });
}

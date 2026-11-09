// Browser test of the real microphone path: Edge is started with a fake
// microphone that plays a WAV of three claps (test/fixtures/mic-*.wav).
// First the bare-room claps are measured as "Before", then a new browser with
// the treated-room claps measures "After" (localStorage keeps the Before).
// Usage: node scripts/e2e-mic.mjs [base-url] [shots-dir]
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5191';
const SHOTS = resolve(process.argv[3] ?? 'shots/e2e');
const { chromium } = await import(pathToFileURL(resolve('../video/node_modules/playwright/index.mjs')).href);
const profile = resolve('test-results/profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

async function run(fixture, slot) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    viewport: { width: 1280, height: 900 },
    permissions: ['microphone'],
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve(fixture)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE);
  await page.click(`.slot[data-slot=${slot}]`);
  await page.click('#listen');
  const t0 = Date.now();
  // Wait until three claps are in this slot, or give up after 45 s.
  await page.waitForFunction(() => document.querySelectorAll('#claps li.got').length === 3, null, { timeout: 45000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const claps = await page.$$eval('#claps li.got', (els) => els.map((e) => e.textContent));
  const status = await page.textContent('#status');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/${slot}-meter.png` });
  await page.screenshot({ path: `${SHOTS}/${slot}-full.png`, fullPage: true });
  await ctx.close();
  return { slot, claps, status, secs, errors };
}

const before = await run('test/fixtures/mic-bare.wav', 'before');
console.log(JSON.stringify(before));
const after = await run('test/fixtures/mic-treated.wav', 'after');
console.log(JSON.stringify(after));

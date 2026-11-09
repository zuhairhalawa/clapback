// README / Devpost screenshots from the sample rooms (simulated data only).
// Usage: node scripts/shots.mjs [base-url]
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.argv[2] ?? 'https://clapback.pages.dev';
const OUT = resolve('docs/screenshots');
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(pathToFileURL(resolve('../video/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] });

async function shoot(viewport, prefix, scale = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${prefix}hero.png` });
  await page.click('[data-sample=bare]');
  await page.waitForFunction(() => document.querySelectorAll('#claps li.got').length === 3 && !document.querySelector('[data-sample]').disabled);
  await page.waitForTimeout(500);
  await (await page.$('#result')).screenshot({ path: `${OUT}/${prefix}result.png` });
  await page.click('[data-sample=treated]');
  await page.waitForFunction(() => !document.querySelector('#compare').hidden && !document.querySelector('[data-sample]').disabled);
  await page.waitForTimeout(800);
  await (await page.$('#compare')).screenshot({ path: `${OUT}/${prefix}compare.png` });
  await ctx.close();
}
await shoot({ width: 1280, height: 860 }, '');
await shoot({ width: 390, height: 844 }, 'phone-', 2);
await browser.close();
console.log('ok');

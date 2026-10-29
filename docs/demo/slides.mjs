// Renders slides/title.html and slides/close.html to slides/png/s01_title.png and s11_close.png
// (1440x900) and copies the title as thumbnail.png. Usage, from the repo root:
//   NODE_PATH=<dir with node_modules/playwright-core> node docs/demo/slides.mjs
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = path.resolve(new URL('.', import.meta.url).pathname);
const OUT = path.join(HERE, 'slides', 'png');
mkdirSync(OUT, { recursive: true });

const SLIDES = { 'title.html': 's01_title.png', 'close.html': 's11_close.png' };

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const [html, png] of Object.entries(SLIDES)) {
  await page.goto('file://' + path.join(HERE, 'slides', html), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, png) });
  console.log('rendered', html, '->', png);
}
await browser.close();
copyFileSync(path.join(OUT, 's01_title.png'), path.join(HERE, 'thumbnail.png'));
console.log('thumbnail.png');

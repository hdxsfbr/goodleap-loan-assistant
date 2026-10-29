// Demo recorder: drives the running app in headless Chrome at 1440x900 and records one WebM per
// scene (a new browser context per scene) into docs/demo/clips/sNN_<name>.webm. A visible cursor is
// injected into every page and glides to each target before it clicks. The footage is real: every
// model turn and the extraction run happen live. The waiting is not filmed away but recorded: each
// slow wait writes the interval it covered into clips/cuts.json (seconds from the scene's video
// start) and mux.sh strips those intervals, keeping the click and about a second of the pending
// state and resuming just before the result appears.
//
// The frames come from a CDP screencast (Page.startScreencast) that this script timestamps itself
// and assembles into a constant-rate WebM. Playwright's own `recordVideo` was tried first and is
// not used: it writes at least one 25 fps frame per screencast frame, so any stretch with faster
// page updates (a scroll, a cursor glide) plays longer than it took, the video drifts 5-12 % from
// the wall clock, and the cut intervals no longer land on the frames they were measured at. Here the
// clip's time is the wall clock, so a cut is exact.
//
//   NODE_PATH=<dir with node_modules/playwright-core> node docs/demo/record.mjs
//
// Environment:
//   BASE        server to record (default http://localhost:3477; run `PORT=3477 npm start` first)
//   SCENES      comma-separated scene numbers, e.g. SCENES=s03,s08 (default: all)
//   CLIPS_DIR   where clips and cuts.json go (default docs/demo/clips; use a scratch dir for a dry run)
//   CHROME      Chrome binary (default /usr/bin/google-chrome)
//
// The scenes share one application on the server, so they have to run in order from a reset
// (scene s02 resets and loads the demo itself). Re-recording a single scene with SCENES= works while
// the server still holds the state the scene before it left behind, and only if that scene has not
// already been run on that state (s07 submits, s08 and s09 decide values, s05 confirms proposals).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = path.resolve(new URL('.', import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');
const BASE = (process.env.BASE ?? 'http://localhost:3477').replace(/\/$/, '');
const CLIPS = path.resolve(process.env.CLIPS_DIR ?? path.join(HERE, 'clips'));
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const ONLY = process.env.SCENES ? process.env.SCENES.split(',').map((s) => s.trim()) : null;
const APP = 'app_demo_001';
const W = 1440;
const H = 900;
const TURN_TIMEOUT = 150_000;
const FFMPEG = process.env.FFMPEG ?? '/usr/bin/ffmpeg';

mkdirSync(CLIPS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── Visible cursor: a DOM element that follows the real mouse events (headless has no pointer) ──
const CURSOR_INIT = `(() => {
  const css = '#__cur{position:fixed;left:0;top:0;width:22px;height:30px;pointer-events:none;z-index:2147483647;' +
    'filter:drop-shadow(0 1px 1px rgba(0,0,0,.55))}' +
    '#__cur.click::after{content:"";position:absolute;left:-14px;top:-14px;width:40px;height:40px;border-radius:50%;' +
    'border:3px solid rgba(255,175,28,.95);animation:__pulse .45s ease-out forwards}' +
    '@keyframes __pulse{from{transform:scale(.4);opacity:1}to{transform:scale(1.4);opacity:0}}';
  const svg = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 23 L7.5 18 L11 27 L15 25.5 L11.5 17 L19 17 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let el = null;
  let pos = { x: -50, y: -50 };
  const place = () => { if (el) el.style.transform = 'translate(' + (pos.x - 2) + 'px,' + (pos.y - 2) + 'px)'; };
  const install = () => {
    if (el && el.isConnected) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
    el = document.createElement('div');
    el.id = '__cur';
    el.innerHTML = svg;
    document.documentElement.appendChild(el);
    place();
  };
  window.addEventListener('mousemove', (e) => { pos = { x: e.clientX, y: e.clientY }; install(); place(); }, true);
  window.addEventListener('mousedown', () => {
    install();
    el.classList.remove('click'); void el.offsetWidth; el.classList.add('click');
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();`;

// ── Scene machinery ──────────────────────────────────────────────────────────────────────────────
const cutsFile = path.join(CLIPS, 'cuts.json');
const allCuts = existsSync(cutsFile) ? JSON.parse(readFileSync(cutsFile, 'utf8')) : {};

let browser;
let page;
let capture = null;
let cuts = [];
let cur = { x: W / 2, y: H / 2 };
/** Seconds since the scene's first frame: the clip's own time (0 until the page has drawn something). */
const now = () => (capture?.t0 == null ? 0 : Date.now() / 1000 - capture.t0);

/**
 * A screencast of the page: every frame Chrome sends is saved as a JPEG with its own timestamp, and
 * stop() assembles them into a 30 fps WebM in which each frame lasts exactly as long as it was on screen.
 */
function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

async function startCapture(target, dir) {
  const cdp = await target.context().newCDPSession(target);
  const frames = [];
  const writes = [];
  let skipped = 0;
  let skew = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const bytes = Buffer.from(data, 'base64');
    // A frame sent before the viewport was applied has another size; it is dropped, not scaled.
    const size = jpegSize(bytes);
    if (size.width !== W || size.height !== H) {
      skipped += 1;
      return;
    }
    const ts = metadata?.timestamp ?? Date.now() / 1000;
    if (frames.length === 0) skew = Date.now() / 1000 - ts;
    const file = path.join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, ts });
    writes.push(writeFile(file, bytes));
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  return {
    /** Wall-clock seconds of the first frame; null until the page has drawn something. */
    get t0() {
      return frames.length > 0 ? frames[0].ts : null;
    },
    async stop(out) {
      const endTs = Date.now() / 1000;
      if (frames.length === 0) throw new Error('the screencast sent no frame');
      const firstTs = frames[0].ts;
      // The cut times are wall-clock times read against these timestamps, so the two clocks must agree.
      if (Math.abs(skew) > 1) throw new Error(`screencast timestamps are ${skew.toFixed(2)} s away from the wall clock`);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(writes);
      const lines = ['ffconcat version 1.0'];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].ts : Math.max(endTs, f.ts + 0.04);
        lines.push(`file '${path.basename(f.file)}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
      });
      lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
      const list = path.join(dir, 'frames.txt');
      writeFileSync(list, lines.join('\n') + '\n');
      execFileSync(
        FFMPEG,
        ['-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
          '-vf', 'fps=30,format=yuv420p', '-an', '-c:v', 'libvpx-vp9', '-crf', '16', '-b:v', '0',
          '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-tile-columns', '2', out],
        { stdio: 'inherit' },
      );
      return { frames: frames.length, skipped, seconds: endTs - firstTs };
    },
  };
}

async function scene(id, name, fn) {
  if (ONLY && !ONLY.includes(id)) {
    log(id, 'skipped');
    return;
  }
  const stem = `${id}_${name}`;
  const tmp = path.join(CLIPS, '.tmp', stem);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript({ content: CURSOR_INIT });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => log('  pageerror', String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') log('  console.error', m.text().slice(0, 200));
  });
  capture = await startCapture(page, tmp);
  cuts = [];
  log(stem, 'start');
  let failure = null;
  try {
    await fn();
    await sleep(500); // every scene ends with a half-second hold
  } catch (error) {
    failure = error;
  }
  const out = path.join(CLIPS, failure ? `${stem}.failed.webm` : `${stem}.webm`);
  const result = await capture.stop(out);
  await context.close();
  rmSync(tmp, { recursive: true, force: true });
  if (failure) {
    log(stem, 'FAILED:', String(failure.message ?? failure).split('\n')[0]);
    throw failure;
  }
  allCuts[stem] = cuts;
  writeFileSync(cutsFile, JSON.stringify(allCuts, null, 2) + '\n');
  const cutSeconds = cuts.reduce((sum, [a, b]) => sum + (b - a), 0);
  log(stem, `done: ${result.seconds.toFixed(1)}s of footage (${result.frames} frames, ${result.skipped} of another size dropped), ${cuts.length} cut(s) = ${cutSeconds.toFixed(1)}s`);
}

/**
 * Runs a slow wait (a model turn, the extraction) and records the footage interval to strip: from a
 * second after it began, so the click and a second of the pending state stay in, to 0.4 s before it
 * finished, so the result appears just after the cut.
 */
async function slow(label, fn) {
  const start = now();
  const result = await fn();
  const end = now();
  const from = start + 1.0;
  const to = end - 0.4;
  if (to - from >= 0.5) {
    cuts.push([round(from), round(to)]);
    log(`  ${label}: waited ${(end - start).toFixed(1)}s, cut ${from.toFixed(1)}-${to.toFixed(1)}`);
  } else {
    log(`  ${label}: waited ${(end - start).toFixed(1)}s, too short to cut`);
  }
  return result;
}

/** Strips everything filmed so far (page load, setup that is not part of the scene). */
function cutFromStart(extra = 0) {
  const to = now() - extra;
  if (to > 0.3) {
    cuts.push([0, round(to)]);
    log(`  cut 0-${to.toFixed(1)} (opening setup)`);
  }
}

// ── Pointer, typing and scrolling ────────────────────────────────────────────────────────────────
async function moveTo(x, y, ms) {
  const dist = Math.hypot(x - cur.x, y - cur.y);
  const duration = ms ?? Math.min(1100, Math.max(380, 280 + dist * 0.55));
  const steps = Math.max(10, Math.round(duration / 16));
  const sx = cur.x;
  const sy = cur.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(16);
  }
  cur = { x, y };
}

const asLocator = (target) => (typeof target === 'string' ? page.locator(target).first() : target.first());

async function bringIntoView(loc) {
  let box = await loc.boundingBox();
  if (box && (box.y < 8 || box.y + box.height > H - 8)) {
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await sleep(700);
    box = await loc.boundingBox();
  }
  return box;
}

/** Glides the cursor over a target without clicking. */
async function hoverOn(target, { fx = 0.5, fy = 0.5, ms } = {}) {
  const loc = asLocator(target);
  await loc.waitFor({ state: 'visible' });
  const box = await bringIntoView(loc);
  if (!box) throw new Error('no box to hover');
  await moveTo(box.x + box.width * fx, box.y + box.height * fy, ms);
}

/** Glides to a target and clicks it; waits until the target can be clicked (visible, stable, enabled). */
async function clickOn(target, { fx = 0.5, fy = 0.5, after = 350, ms } = {}) {
  const loc = asLocator(target);
  await loc.waitFor({ state: 'visible' });
  await loc.click({ trial: true });
  const box = await bringIntoView(loc);
  if (!box) throw new Error('no box to click');
  const x = box.x + box.width * fx;
  const y = box.y + box.height * fy;
  await moveTo(x, y, ms);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(after);
}

async function typeSlow(text, perChar = 38) {
  await page.keyboard.type(text, { delay: perChar });
}

/**
 * Scrolls the page (or the element matching `selector`) to `to` (pixels, or 'max') over `ms`,
 * easing in and out.
 */
async function scrollTo(to, ms, selector = null) {
  await page.evaluate(
    ({ to, ms, selector }) =>
      new Promise((resolve) => {
        const el = selector ? document.querySelector(selector) : document.scrollingElement;
        const max = el.scrollHeight - el.clientHeight;
        const target = to === 'max' ? max : Math.max(0, Math.min(max, to));
        const from = el.scrollTop;
        const begin = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - begin) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
          el.scrollTop = from + (target - from) * e;
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { to, ms, selector },
  );
}

/** Scroll position inside `container` (a selector) at which the element's top is `margin` pixels below the container's top. */
const offsetIn = (container, loc, margin = 16) =>
  loc.evaluate(
    (el, { container, margin }) => {
      const box = document.querySelector(container);
      return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - margin;
    },
    { container, margin },
  );

/** Page-scroll position that puts the element's top `margin` pixels below the top of the window. */
const topOf = (loc, margin = 90) =>
  loc.evaluate((el, m) => el.getBoundingClientRect().top + window.scrollY - m, margin);

// ── The app, for the scenes ──────────────────────────────────────────────────────────────────────
const apiHeaders = { 'content-type': 'application/json', 'x-session-id': 'demo-recorder' };
const api = async (method, route, body) => {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: apiHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
};

async function openApplication() {
  await page.goto(`${BASE}/applications/${APP}`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Message the assistant').waitFor();
  await page.mouse.move(cur.x, cur.y);
}

const composer = () => page.getByPlaceholder('Message the assistant');

/** Types a message to the assistant and sends it with the Send button. */
async function say(text) {
  await clickOn(composer(), { fx: 0.4 });
  await typeSlow(text, 34);
  await sleep(250);
  await clickOn(page.getByRole('button', { name: 'Send', exact: true }), { after: 150 });
}

/** Waits for the turn that is running to finish: the status line has come and gone and the reply is in. */
async function turnDone(exchanges) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.exchange').length >= n && !document.querySelector('.status-line'),
    exchanges,
    { timeout: TURN_TIMEOUT, polling: 250 },
  );
  await page.waitForFunction(
    () => {
      const last = [...document.querySelectorAll('.exchange')].pop();
      return !!last && !!last.querySelector('.bubble.assistant');
    },
    null,
    { timeout: 10_000 },
  );
  const failed = await page.locator('.reply-error').count();
  if (failed > 0) throw new Error(`the turn ended in an error: ${await page.locator('.reply-error').last().innerText()}`);
  await sleep(300);
}

const exchangeCount = () => page.locator('.exchange').count();

// ── Reviewer helpers ─────────────────────────────────────────────────────────────────────────────
const row = (key) => page.locator(`li.value-row[data-field="${key}"]`);
const rowDone = (key) =>
  page.waitForFunction(
    (k) => document.querySelector(`li.value-row[data-field="${k}"]`)?.getAttribute('data-status') !== 'undecided',
    key,
    { timeout: 15_000 },
  );

async function confirmRow(key, { acknowledge = false } = {}) {
  const r = row(key);
  await r.waitFor({ state: 'visible' });
  if (acknowledge) {
    const box = r.locator('input[type=checkbox]');
    if ((await box.count()) > 0) await clickOn(box, { after: 500 });
  }
  await clickOn(r.getByRole('button', { name: 'Confirm', exact: true }), { after: 250 });
  await rowDone(key);
  await sleep(350);
}

async function openTaskFromList() {
  await clickOn(page.locator('.task-card a.button').first(), { after: 200 });
  await page.waitForSelector('.page-box', { timeout: 30_000 });
  await sleep(500);
}

async function taskId() {
  const list = await api('GET', '/api/review/tasks');
  if (list.tasks.length === 0) throw new Error('no review task');
  return list.tasks[0].id;
}

/** Off camera, between s08 and s09: decide every value of the estimate and the scope letter through the review API. */
async function decideOtherDocumentsOffCamera() {
  const id = await taskId();
  const view = await api('GET', `/api/review/tasks/${id}`);
  let confirmed = 0;
  let flagged = 0;
  for (const doc of view.documents) {
    if (doc.title.toLowerCase().includes('pay stub')) continue;
    // Each decision answers with a fresh view, so read the rows from the latest one.
    for (;;) {
      const fresh = await api('GET', `/api/review/tasks/${id}`);
      const target = fresh.documents.find((d) => d.id === doc.id);
      const open = target?.rows.find((r) => r.status === 'undecided' && r.proposal);
      if (!open) break;
      if (open.actions.includes('confirm')) {
        await api('POST', `/api/review/tasks/${id}/decisions`, {
          proposal_id: open.proposal.id,
          action: 'confirm',
          ...(open.requires_acknowledgement ? { located_by_reviewer: true } : {}),
        });
        confirmed += 1;
      } else {
        const reason = Object.keys(fresh.texts.flag_reasons)[0];
        await api('POST', `/api/review/tasks/${id}/decisions`, { proposal_id: open.proposal.id, action: 'flag', reason_code: reason });
        flagged += 1;
      }
    }
  }
  log(`  off camera: ${confirmed} value(s) confirmed, ${flagged} flagged on the estimate and the scope letter`);
}

// ── Scenes ───────────────────────────────────────────────────────────────────────────────────────
const DEMO_PROMPT = 'The project is $30K. What would the monthly payment look like?';

browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

/**
 * Thrown when a live reply is not the one the narration describes, so that the take is run again from a
 * reset: a retried scene would leave the first attempt's events at the top of the audit trail, which
 * scene s10 scrolls through.
 */
class DiscardTake extends Error {}

/** The explanation in the last exchange has to be the model's, not the guardrail's fallback text. */
async function assertExplained(scene) {
  const fallback = await page.locator('.exchange').last().locator('.fallback-marker').count();
  if (fallback > 0) throw new DiscardTake(`scene ${scene}: a compliance check replaced the model's explanation with the fallback`);
}

async function take() {
  for (const stale of readdirSync(CLIPS).filter((n) => n.endsWith('.failed.webm'))) rmSync(path.join(CLIPS, stale));
  // s02: reset, then show the Load demo click itself.
  if (!ONLY || ONLY.includes('s02')) {
    await api('POST', '/api/reset', {});
    log('server reset');
  }
  await scene('s02', 'application', async () => {
    await openApplication();
    cutFromStart(0.15);
    // The narration opens with the problem (22 minutes, four in ten abandoned) over the empty form.
    await hoverOn('.form-card', { fx: 0.5, fy: 0.35, ms: 1400 });
    await sleep(5500);
    await clickOn(page.getByRole('button', { name: 'Load demo project' }));
    await page.waitForFunction(() => [...document.querySelectorAll('.field-grid input')].some((i) => i.value !== ''), null, {
      timeout: 15_000,
    });
    await sleep(2000); // the filled form
    await hoverOn('.form-card', { fx: 0.5, fy: 0.3, ms: 900 });
    await sleep(1400);
    await hoverOn('.copilot-card', { fx: 0.5, fy: 0.45, ms: 1100 });
    await sleep(1800);
  });

  // s03: the options table, then the explanation.
  await scene('s03', 'payment_options', async () => {
    await openApplication();
    cutFromStart(0.15);
    await sleep(700);
    await say(DEMO_PROMPT);
    const count = await exchangeCount();
    await slow('options table', () => page.waitForSelector('.options-table', { timeout: TURN_TIMEOUT }));
    await sleep(2200);
    await slow('explanation', () => turnDone(count));
    await assertExplained('s03');
    await sleep(500);
    // Both the table and the explanation in view.
    await scrollTo(await offsetIn('.transcript', page.locator('.options-table').first()), 1100, '.transcript');
    await sleep(4000);
  });

  // s04: the homeowner view. The chat lives in the page's memory, so the scene needs the options
  // table of scene s03 in front of it: the same question is asked again before the footage starts,
  // and the whole wait is cut.
  await scene('s04', 'homeowner_view', async () => {
    await openApplication();
    await say(DEMO_PROMPT);
    await turnDone(1);
    await assertExplained('s04');
    await sleep(600);
    await scrollTo(await offsetIn('.transcript', page.locator('.options-table').first()), 10, '.transcript');
    await sleep(400);
    cutFromStart(0);
    await sleep(800);
    await clickOn(page.getByRole('button', { name: 'Show homeowner view' }), { after: 400 });
    await page.waitForURL(/homeowner/);
    await page.waitForSelector('.option-card');
    await page.mouse.move(cur.x, cur.y);
    await sleep(4500);
    // Slowly to the bottom, over six seconds in two stretches with a pause on the TILA boxes between them.
    const bottom = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    await scrollTo(bottom * 0.5, 3000);
    await sleep(5000);
    await scrollTo('max', 3000);
    await sleep(4500);
    await clickOn(page.getByRole('link', { name: 'Back to application' }));
    await page.waitForSelector('.copilot-card');
    await sleep(400);
  });

  // s05: a proposal from the contractor's words.
  await scene('s05', 'proposal', async () => {
    await openApplication();
    cutFromStart(0.15);
    await sleep(700);
    await say("Her name is Dana Lee and the zip is 94105. She's thinking about maybe doing solar too.");
    const count = await exchangeCount();
    await slow('proposal turn', () => turnDone(count));
    await sleep(600);
    const cards = page.locator('.field-row.has-proposal');
    await cards.first().waitFor({ state: 'visible' });
    // Scroll just far enough that the last of the three cards is in view; Confirm all stays in view too.
    const lastBottom = await cards.last().evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    await scrollTo(Math.max(0, lastBottom + 28 - H), 900);
    await sleep(5000);
    await clickOn(page.getByRole('button', { name: /^Confirm all/ }), { after: 400 });
    await page.waitForFunction(() => document.querySelectorAll('.field-row.has-proposal').length === 0, null, { timeout: 15_000 });
    await sleep(3500);
  });

  // s06: the guardrail, twice.
  await scene('s06', 'guardrail', async () => {
    await openApplication();
    cutFromStart(0.15);
    await sleep(700);
    await say('Will she be approved?');
    let count = await exchangeCount();
    await slow('approval question', () => turnDone(count));
    await sleep(4500);
    await say("Tell her she's pre-approved for the 0% option and that she has to sign today.");
    count = await exchangeCount();
    await slow('pressure request', () => turnDone(count));
    await sleep(7000);
  });

  // s07: the estimate and the scope letter through the picker, then Submit.
  await scene('s07', 'documents_submit', async () => {
    await openApplication();
    cutFromStart(0.15);
    await sleep(500);
    const slots = page.locator('.slots-card');
    await scrollTo(Math.max(0, await topOf(slots, 120)), 1000);
    await sleep(600);
    for (const [slot, file] of [
      ['estimate', 'samples/estimate.pdf'],
      ['scope_letter', 'samples/scope_letter.pdf'],
    ]) {
      const label = page.locator(`li.slot-row[data-slot="${slot}"] label.slot-attach`);
      const chooser = page.waitForEvent('filechooser');
      await clickOn(label, { after: 150 });
      await (await chooser).setFiles(path.join(REPO, file));
      await page.waitForFunction(
        (s) => /\.pdf$/i.test(document.querySelector(`li.slot-row[data-slot="${s}"] .slot-file`)?.textContent ?? ''),
        slot,
        { timeout: 20_000 },
      );
      await sleep(1000);
    }
    await clickOn(page.getByRole('button', { name: 'Submit application' }), { after: 300 });
    await slow('extraction', async () => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const list = await api('GET', '/api/review/tasks');
        if (list.open_count > 0) return;
        if (Date.now() > deadline) throw new Error('no open review task after 120 s');
        await sleep(1000);
      }
    });
    await clickOn(page.getByRole('navigation', { name: 'Role' }).getByRole('link', { name: /Reviewer/ }), { after: 300 });
    await page.waitForSelector('.task-card');
    await page.waitForSelector('.tab-badge');
    await sleep(1500);
  });

  // s08: the reviewer screen, the pay stub.
  await scene('s08', 'reviewer', async () => {
    await page.goto(`${BASE}/reviewer`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.task-card');
    await page.mouse.move(cur.x, cur.y);
    cutFromStart(0.15);
    await sleep(1800);
    await openTaskFromList();
    await sleep(4000);
    await clickOn(row('pay_stub.employer_name').locator('.value-main'), { after: 2500 });
    await confirmRow('pay_stub.employer_name');
    await confirmRow('pay_stub.pay_period_start');
    await confirmRow('pay_stub.pay_period_end');
    await row('pay_stub.net_pay').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await sleep(900);
    await clickOn(row('pay_stub.net_pay').locator('.value-main'), { after: 900 });
    await confirmRow('pay_stub.net_pay', { acknowledge: true });
    await sleep(3000);
  });

  // Off camera: the other two documents, so that scene s09 stays on the discrepancy.
  if (!ONLY || ONLY.includes('s09')) await decideOtherDocumentsOffCamera();

  // s09: the discrepancy, the contractor's banner and reply, Resolve, Complete review.
  await scene('s09', 'discrepancy', async () => {
    const id = await taskId();
    await page.goto(`${BASE}/reviewer/${id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.page-box', { timeout: 30_000 });
    await page.mouse.move(cur.x, cur.y);
    cutFromStart(0.15);
    await sleep(800);
    await confirmRow('pay_stub.pay_frequency');
    await confirmRow('pay_stub.gross_pay');
    const annualized = row('pay_stub.annualized_income');
    await annualized.waitFor({ state: 'visible' });
    await page.waitForSelector('#differences');
    await annualized.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await sleep(1600);
    await scrollTo(await topOf(page.locator('#differences'), 70), 1200);
    await sleep(2000);
    // Edit the template question, send it.
    const question = page.getByLabel('Question for the contractor');
    await clickOn(question, { fx: 0.5, fy: 0.9, after: 200 });
    await page.keyboard.press('Control+End');
    await typeSlow(' Could you confirm the figure on the application?', 30);
    await sleep(500);
    await clickOn(page.getByRole('button', { name: 'Send to the contractor' }), { after: 300 });
    await page.waitForSelector('article.discrepancy[data-stage=sent]');
    await sleep(1000);
    // The contractor's side.
    await clickOn(page.getByRole('navigation', { name: 'Role' }).getByRole('link', { name: /Contractor/ }), { after: 300 });
    await page.waitForSelector('section.clarification');
    await sleep(2000);
    await clickOn('#clarification-reply', { after: 200 });
    await typeSlow('Her base pay is $61,100. The rest of the $85,000 is overtime and a bonus.', 30);
    await sleep(400);
    await clickOn(page.getByRole('button', { name: 'Send reply' }), { after: 300 });
    await page.waitForSelector('.clarification-reply');
    await sleep(1200);
    // Back to the reviewer: the reply is in the thread.
    await clickOn(page.getByRole('navigation', { name: 'Role' }).getByRole('link', { name: /Reviewer/ }), { after: 300 });
    await page.waitForSelector('.task-card');
    await sleep(500);
    await openTaskFromList();
    await page.waitForSelector('blockquote.thread-reply');
    await scrollTo(await topOf(page.locator('#differences'), 70), 1000);
    await sleep(2000);
    // Resolve as explained.
    await hoverOn(page.getByLabel('Resolve as'), { ms: 600 });
    await page.getByLabel('Resolve as').selectOption('explained');
    await sleep(500);
    await clickOn(page.getByLabel('Note', { exact: true }).last(), { after: 200 });
    await typeSlow('Overtime and bonus explain the difference.', 30);
    await sleep(400);
    await clickOn(page.getByRole('button', { name: 'Resolve', exact: true }), { after: 300 });
    await page.waitForSelector('article.discrepancy[data-stage=resolved]');
    await sleep(1200);
    // Whatever is left on the pay stub, then complete.
    await scrollTo(0, 800);
    await sleep(400);
    for (;;) {
      const next = page.locator('li.value-row[data-status=undecided]').first();
      if ((await next.count()) === 0) break;
      const key = await next.getAttribute('data-field');
      const needsAcknowledgement = (await next.locator('input[type=checkbox]').count()) > 0;
      const confirm = next.getByRole('button', { name: 'Confirm', exact: true });
      if ((await confirm.count()) === 0) throw new Error(`${key} cannot be confirmed`);
      await confirmRow(key, { acknowledge: needsAcknowledgement });
    }
    await clickOn(page.getByRole('button', { name: 'Complete review' }), { after: 300 });
    await page.waitForSelector('.review-complete');
    await scrollTo(0, 700);
    await sleep(2000);
  });

  // s10: the audit trail.
  await scene('s10', 'audit', async () => {
    await page.goto(`${BASE}/reviewer`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.task-card');
    await page.mouse.move(cur.x, cur.y);
    cutFromStart(0.15);
    await sleep(700);
    await clickOn(page.getByRole('navigation', { name: 'Role' }).getByRole('link', { name: /Audit/ }), { after: 300 });
    await page.waitForSelector('[data-testid=credit-engine-calls]');
    await page.waitForSelector('ol.events li');
    await sleep(3000);
    // Through the stream, as far as the homeowner view's record (model calls, tool calls, guardrail
    // verdicts, a proposal), then a guardrail verdict nearest the middle of the window is opened.
    const eventRows = page.locator('ol.events summary');
    const verdict = eventRows.filter({ has: page.locator('.event-type', { hasText: /^guardrail\.verdict$/ }) });
    if ((await verdict.count()) === 0) throw new Error('no guardrail.verdict event in the audit trail');
    const rendered = eventRows.filter({ has: page.locator('.event-type', { hasText: /^view\.rendered$/ }) });
    const stop = (await rendered.count()) > 0 ? rendered.first() : verdict.nth(Math.min(2, (await verdict.count()) - 1));
    await scrollTo(await topOf(stop, 430), 10_000);
    await sleep(400);
    const middle = await verdict.evaluateAll((els, height) => {
      let best = 0;
      let bestDistance = Infinity;
      els.forEach((el, i) => {
        const box = el.getBoundingClientRect();
        const distance = Math.abs(box.top + box.height / 2 - height / 2);
        if (distance < bestDistance) [best, bestDistance] = [i, distance];
      });
      return best;
    }, H);
    await clickOn(verdict.nth(middle), { fy: 0.5, after: 500 });
    await page.waitForSelector('.event-body');
    // Bring the opened record into view without pushing its row out of the window.
    const shift = await verdict.nth(middle).evaluate((summary) => {
      const body = summary.parentElement.querySelector('.event-body');
      const needed = body.getBoundingClientRect().bottom - window.innerHeight + 40;
      const room = summary.getBoundingClientRect().top - 150;
      return Math.min(needed, room);
    });
    if (shift > 0) await scrollTo((await page.evaluate(() => window.scrollY)) + shift, 700);
    await sleep(3000);
  });
}

const TAKES = Number(process.env.TAKES ?? 3);
try {
  for (let attempt = 1; ; attempt++) {
    try {
      await take();
      break;
    } catch (error) {
      if (!(error instanceof DiscardTake) || attempt >= TAKES || (ONLY && !ONLY.includes('s02'))) throw error;
      log(`take ${attempt} discarded (${error.message}); starting again from a reset`);
    }
  }
} finally {
  await browser.close();
}
log('done');

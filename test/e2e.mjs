// End-to-end test: headless Chromium against the demo trainer (no Bluetooth needed).
// Run with:  node test/e2e.mjs      Prints PASS / FAIL lines, exits non-zero on any failure.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// `node --test` would pick this file up too. It takes minutes and starts a browser, so it only runs when called directly.
if (process.env.NODE_TEST_CONTEXT && !process.env.ERG_E2E) {
  console.log('SKIP e2e: run it directly with `node test/e2e.mjs`');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const core = require('../core.js');
const { WORKOUTS } = require('../workouts.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wk = id => WORKOUTS.find(w => w.id === id);

// ---- tiny static server on a free port ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---- Fake Web Bluetooth, injected before the page loads (scenario 4) ----
// Enforces "one GATT operation at a time" like a real browser (a second one while another runs throws),
// and records every operation, write and UUID the app uses.
function fakeBluetooth() {
  const U = { FTMS: '00001826-0000-1000-8000-00805f9b34fb', BIKE: '00002ad2-0000-1000-8000-00805f9b34fb', CP: '00002ad9-0000-1000-8000-00805f9b34fb',
              HRS: '0000180d-0000-1000-8000-00805f9b34fb', HRM: '00002a37-0000-1000-8000-00805f9b34fb' };
  const bt = window.__bt = { ops: [], inflight: 0, overlaps: 0, badUuids: [], written: [], usedWriteValue: 0, requests: [], connects: 0,
    opDelay: 0, writeDelay: 0, connectFails: 0, cpResult: 0x01, cpSilent: false, noWriteWithResponse: false };
  const hex = v => Array.from(new Uint8Array(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)).map(b => b.toString(16).padStart(2, '0')).join('');
  const checkUuid = u => { if (typeof u !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)) bt.badUuids.push(String(u)); };
  async function op(name, delay, fn) {
    if (bt.inflight) { bt.overlaps++; throw new DOMException('GATT operation already in progress.', 'NetworkError'); }
    bt.inflight++; bt.ops.push(name);
    try { if (delay) await new Promise(r => setTimeout(r, delay)); else { await Promise.resolve(); await Promise.resolve(); } return await fn(); }
    finally { bt.inflight--; }
  }
  const mkChar = (uuid, onWrite) => {
    const c = new EventTarget();
    Object.assign(c, { uuid, value: null,
      async startNotifications() { return op('notify ' + uuid, bt.opDelay, () => c); },
      notify(bytes) { c.value = new DataView(Uint8Array.from(bytes).buffer); c.dispatchEvent(new Event('characteristicvaluechanged')); } });
    if (onWrite) {
      const write = async v => op('write ' + hex(v), bt.writeDelay, () => { bt.written.push(hex(v)); onWrite(v); });
      if (!bt.noWriteWithResponse) c.writeValueWithResponse = write;
      c.writeValue = async v => { bt.usedWriteValue++; return write(v); };
    }
    return c;
  };
  function makeDevice(name, kind) {
    const dev = new EventTarget(), gatt = { connected: false, device: dev };
    const needConn = () => { if (!gatt.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError'); };
    gatt.connect = async () => op('connect', bt.opDelay, async () => {
      bt.connects++;
      if (bt.connectFails > 0) { bt.connectFails--; throw new DOMException('Connection attempt failed.', 'NetworkError'); }
      gatt.connected = true; return gatt;
    });
    gatt.disconnect = () => { gatt.connected = false; };
    let chars;
    gatt.getPrimaryService = async uuid => { checkUuid(uuid); return op('service ' + uuid, bt.opDelay, () => {
      needConn();
      if (uuid !== (kind === 'trainer' ? U.FTMS : U.HRS)) throw new DOMException('Service not found.', 'NotFoundError');
      if (kind === 'trainer') {
        const cp = mkChar(U.CP, v => { const o = new Uint8Array(v.buffer ? v.buffer : v)[0]; if (!bt.cpSilent) setTimeout(() => cp.notify([0x80, o, o === 0 ? bt.cpResult : 0x01]), 0); });
        const bike = mkChar(U.BIKE); chars = { [U.BIKE]: bike, [U.CP]: cp }; bt.bike = bike; bt.cp = cp;
      } else { const hr = mkChar(U.HRM); chars = { [U.HRM]: hr }; bt.hr = hr; }
      return { getCharacteristic: async cu => { checkUuid(cu); return op('char ' + cu, bt.opDelay, () => { needConn(); if (!chars[cu]) throw new DOMException('not found', 'NotFoundError'); return chars[cu]; }); } };
    }); };
    Object.assign(dev, { name, id: name, gatt });
    (bt.drops = bt.drops || {})[kind] = () => { gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); };
    bt.drop = k => bt.drops[k || 'trainer']();
    return dev;
  }
  navigator.bluetooth = { async requestDevice(o) {
    bt.requests.push(JSON.parse(JSON.stringify(o)));
    const hr = !!(o.filters && o.filters[0] && o.filters[0].services && o.filters[0].services[0] === U.HRS);
    return makeDevice(hr ? 'HR Strap 9' : 'KICKR CORE 1234', hr ? 'hr' : 'trainer');
  } };
}

// ---- PASS / FAIL reporting ----
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}
const best60 = samples => {                         // independent of core.js on purpose
  const p = samples.map(s => (s.power == null ? 0 : s.power));
  let best = -1;
  for (let i = 0; i + 60 <= p.length; i++) { let sum = 0; for (let j = i; j < i + 60; j++) sum += p[j]; best = Math.max(best, sum / 60); }
  return best;
};

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const problems = [];
  const watch = page => {
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  };
  const newPage = async (viewport) => {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1180, height: 820 }, acceptDownloads: true });
    await ctx.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined }); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage();
    watch(page);
    return page;
  };
  const toSummary = (page, ms) => page.waitForFunction(() => window.__erg.state.screen === 'summary', null, { timeout: ms || 150000, polling: 250 });

  // =========================================================================
  // 0. Hooks and the demo button stay hidden without URL flags
  // =========================================================================
  {
    const page = await newPage();
    await page.goto(base + '/index.html');
    check('no test hooks without ?sim / ?speed', await page.evaluate(() => typeof window.__erg === 'undefined'));
    check('no Demo trainer button without ?sim=1', (await page.getByRole('button', { name: 'Demo trainer' }).count()) === 0);
    check('plain-language note when Bluetooth is missing', /can.t do Bluetooth/.test(await page.textContent('body')));
    check('Connect Trainer button is there', (await page.getByRole('button', { name: 'Connect Trainer' }).count()) === 1);
    await page.context().close();
  }

  // =========================================================================
  // 1. Ramp test with the demo trainer failing at 380 W
  // =========================================================================
  const page = await newPage();
  await page.goto(base + '/index.html?sim=1&speed=60&simFail=380');
  check('Demo trainer button shows with ?sim=1', (await page.getByRole('button', { name: 'Demo trainer' }).count()) === 1);
  await page.getByRole('button', { name: 'Demo trainer' }).click();
  check('demo trainer connects', /Demo trainer ready/.test(await page.textContent('#status')));
  await page.getByRole('button', { name: 'Continue' }).click();
  check('library shows "FTP not set" line', (await page.textContent('#ftpLine')).includes('FTP not set'));
  check('Ramp Test is the suggested workout', (await page.locator('.wk[data-id="ramp"] .badge.sug').count()) === 1);
  check('no text inputs on the library screen', (await page.locator('input[type=text], input[type=number], textarea').count()) === 0);

  check('ramp test starts', await page.evaluate(() => window.__erg.startWorkout('ramp')));
  await page.waitForTimeout(1200);
  check('ride screen is up and the clock runs', await page.evaluate(() => window.__erg.state.screen === 'ride' && window.__erg.state.ride.elapsed > 5));
  check('"I’m done" replaces Skip in the ramp test', (await page.textContent('#bSkip')).includes('done'));
  await toSummary(page);

  const ramp = await page.evaluate(() => ({
    rt: window.__erg.state.ride.rampTest, samples: window.__erg.getSamples(), segs: window.__erg.state.ride.segments.map(s => ({ kind: s.kind, start: s.start, dur: s.dur })),
    spoken: window.__erg.spoken.slice(), log: window.__erg.state.trainer.log.slice()
  }));
  const expectFtp = Math.round(0.75 * best60(ramp.samples));
  check('ramp test failed on the simulated collapse', ramp.rt.failed === true);
  check('ramp FTP = round(0.75 x best 60 s power)  [' + ramp.rt.ftp + ' vs ' + expectFtp + ']', ramp.rt.ftp === expectFtp, ramp.rt.ftp);
  check('ramp FTP is in 240..300', ramp.rt.ftp >= 240 && ramp.rt.ftp <= 300, ramp.rt.ftp);
  check('ramp samples are 1 Hz and in order', ramp.samples.every((s, i) => s.t === i));
  check('ramp targets follow 100 + 20 W per minute', ramp.samples.slice(0, 840).every(s => s.target === 100 + 20 * Math.floor(s.t / 60)));
  check('plan rewritten: ramp test then a 5-minute cooldown', ramp.segs.length === 2 && ramp.segs[0].kind === 'ramptest' && ramp.segs[1].dur === 300 && ramp.segs[1].start === ramp.segs[0].dur, JSON.stringify(ramp.segs));
  const coolW = Math.max(60, Math.round(0.4 * ramp.rt.ftp));
  check('cooldown target is max(60, 0.4 x FTP) = ' + coolW, ramp.log.some(e => e.kind === 'erg' && e.value === coolW && e.t === ramp.segs[1].start), JSON.stringify(ramp.log.slice(-3)));
  check('spoke "Done. Your FTP is ' + ramp.rt.ftp + '."', ramp.spoken.includes('Done. Your FTP is ' + ramp.rt.ftp + '.'));
  check('ramp steps were announced as bare watts', ramp.spoken.includes('120') && ramp.spoken.includes('380'));

  check('summary asks to update the FTP', (await page.textContent('#ftpPrompt')).includes('Your FTP looks like ' + ramp.rt.ftp + '. Update?'));
  await page.getByRole('button', { name: 'Use ' + ramp.rt.ftp }).click();
  const saved = await page.evaluate(() => ({ ftp: window.__erg.state.ftp, kind: window.__erg.state.ftpSource.kind, stored: JSON.parse(localStorage.getItem('erg.v1')) }));
  check('FTP updated from the ramp test and stored locally', saved.ftp === ramp.rt.ftp && saved.kind === 'ramp' && saved.stored.ftp === ramp.rt.ftp);
  await page.getByRole('button', { name: 'Done' }).click();
  check('library header shows the new FTP and its source', /^FTP \d+ · ramp test, /.test(await page.textContent('#ftpLine')), await page.textContent('#ftpLine'));

  // =========================================================================
  // 2. Sweet Spot 3x12 at speed 60
  // =========================================================================
  const FTP = ramp.rt.ftp;
  check('ss3x12 starts', await page.evaluate(() => window.__erg.startWorkout('ss3x12')));
  await page.waitForTimeout(600);
  const shot = await page.evaluate(() => ({ t: document.getElementById('vT').textContent, n: document.getElementById('vN').textContent }));
  check('ride screen shows a target and a "Next:" line', /^\d+$/.test(shot.t) && /^Next: /.test(shot.n), JSON.stringify(shot));
  await toSummary(page);

  const flat = core.flattenWorkout(wk('ss3x12'), FTP);
  const ss = await page.evaluate(() => {
    const r = window.__erg.state.ride, S = window.__erg.state.summary;
    return {
      segCount: r.segments.length, samples: window.__erg.getSamples(), log: window.__erg.state.trainer.log.slice(), ftp: r.ftp, scale: r.scale,
      tss: S.metrics.tss, np: S.metrics.np, planned: r.tssEstimate, spoken: window.__erg.spoken.slice(), beeps: window.__erg.testLog.beeps,
      shownTss: document.getElementById('sTss').textContent
    };
  });
  check('ss3x12 has 1 + 6 + 1 = 8 segments', ss.segCount === 8 && flat.segments.length === 8, ss.segCount);
  check('ss3x12 recorded 3960 samples, one per second', ss.samples.length === 3960 && ss.samples.every((s, i) => s.t === i), ss.samples.length);
  check('ride used the FTP that was set (' + FTP + ')', ss.ftp === FTP, ss.ftp);

  // what the demo trainer was told, second by second, against targetAt()
  const sentAt = s => { let v = null; for (const e of ss.log) if (e.kind === 'erg' && e.t <= s) v = e.value; return v; };
  const secs = [0, 1, 150, 299, 300, 599, 600, 601, 1319, 1320, 1500, 1620, 2339, 2340, 3659, 3660, 3800, 3959];
  const bad = secs.filter(s => sentAt(s) !== core.targetAt(flat.segments, s, FTP, 1)).map(s => s + ':' + sentAt(s) + '/' + core.targetAt(flat.segments, s, FTP, 1));
  check('targets sent to the trainer match targetAt() at ' + secs.length + ' sampled seconds', bad.length === 0, bad.join(' '));
  const badSamples = secs.filter(s => ss.samples[s].target !== core.targetAt(flat.segments, s, FTP, 1));
  check('recorded sample targets match targetAt()', badSamples.length === 0, badSamples.join(','));
  check('work blocks sit at 90% of FTP', sentAt(700) === Math.round(0.9 * FTP) && sentAt(2000) === Math.round(0.9 * FTP), sentAt(700));

  const tssGap = Math.abs(ss.tss - flat.tssEstimate) / flat.tssEstimate;
  check('summary TSS within 5% of the plan  [' + ss.tss.toFixed(1) + ' vs ' + flat.tssEstimate.toFixed(1) + ']', tssGap < 0.05, (tssGap * 100).toFixed(2) + '%');
  check('engine and core agree on the planned TSS', Math.abs(ss.planned - flat.tssEstimate) < 1e-9);
  check('summary screen shows the rounded TSS', ss.shownTss === String(Math.round(ss.tss)), ss.shownTss);

  const workWatts = Math.round(0.9 * FTP);
  check('voice: "12 minutes at ' + workWatts + ' watts."', ss.spoken.includes('12 minutes at ' + workWatts + ' watts.'));
  check('voice: "Easy, 5 minutes." for rests', ss.spoken.filter(t => t === 'Easy, 5 minutes.').length === 4);   // 3 rests + the cooldown ramp
  check('voice: "Ten seconds." before each of the 3 work blocks ends', ss.spoken.filter(t => t === 'Ten seconds.').length === 3);
  check('voice: "Halfway." in the warm-up and each work block', ss.spoken.filter(t => t === 'Halfway.').length === 4);
  check('beeps: 3 per transition into a harder segment (3 transitions)', ss.beeps === 9, ss.beeps);
  check('no stray auto-ease', !ss.spoken.includes('Easing 5 percent') && ss.scale === 1);

  // ---- history, export, delete ----
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.waitForTimeout(300);
  check('history lists both rides', (await page.locator('.list .item').count()) === 2, await page.locator('.list .item').count());
  await page.locator('.list .item', { hasText: 'Sweet Spot 3x12' }).click();
  check('history item opens the same summary view', (await page.textContent('h1')).includes('Sweet Spot 3x12') && (await page.locator('#sTss').count()) === 1);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: 'Export TCX' }).click()]);
  const tcx = fs.readFileSync(await dl.path(), 'utf8');
  check('TCX file name looks like erg-YYYY-MM-DD-sweet-spot-3x12.tcx', /^erg-\d{4}-\d{2}-\d{2}-sweet-spot-3x12\.tcx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('TCX has one Trackpoint per sample and a Watts element each', (tcx.match(/<Trackpoint>/g) || []).length === 3960 && (tcx.match(/<ns3:Watts>/g) || []).length === 3960);
  check('TCX notes carry the workout name', tcx.includes('<Notes>ERG: Sweet Spot 3x12</Notes>'));
  const delBtn = page.getByRole('button', { name: 'Delete' });
  await delBtn.click();
  check('delete needs a second tap', (await page.locator('.item').count()) === 0 && /Tap again/.test(await page.textContent('[data-act=delete]')));
  await page.locator('[data-act=delete]').click();
  await page.waitForTimeout(300);
  check('second tap deletes the ride', (await page.locator('.list .item').count()) === 1);

  // ---- settings ----
  await page.getByRole('button', { name: '‹ Library' }).click();
  await page.getByRole('button', { name: /^FTP / }).click();
  const before = Number(await page.textContent('#ftpVal'));
  await page.locator('[data-act=ftp-step][data-d="10"]').click();
  await page.locator('[data-act=ftp-step][data-d="-1"]').click();
  check('FTP stepper moves in 10s and 1s', Number(await page.textContent('#ftpVal')) === before + 9);
  await page.locator('[data-act=toggle][data-k=voice]').click();
  check('voice toggle works and is stored', (await page.evaluate(() => JSON.parse(localStorage.getItem('erg.v1')).settings.voice)) === false);
  await page.locator('[data-act=toggle][data-k=voice]').click();
  await page.locator('[data-act=clear]').click();
  check('clear history needs a second tap', /Tap again/.test(await page.textContent('[data-act=clear]')));
  await page.locator('[data-act=clear]').click();
  await page.waitForTimeout(400);
  check('history cleared', (await page.evaluate(() => window.__erg.ui.history.length)) === 0);
  await page.context().close();

  // =========================================================================
  // 3. No FTP yet: "Set FTP first" sheet, hand-set stepper, layout, two-tap End
  // =========================================================================
  {
    const p = await newPage();
    await p.goto(base + '/index.html?sim=1&speed=60');
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.locator('.wk[data-id="ss3x12"]').click();
    const startBtn = p.getByRole('button', { name: 'Start', exact: true });
    check('Start is disabled with a reason when no trainer is connected', (await startBtn.isDisabled()) && /Connect a trainer first/.test(await p.textContent('body')));
    check('"Ride without trainer" is hidden in sim mode', (await p.getByRole('button', { name: 'Ride without trainer' }).count()) === 0);
    await p.getByRole('button', { name: 'Connect trainer' }).click();
    await p.getByRole('button', { name: 'Demo trainer' }).click();
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.locator('.wk[data-id="ss3x12"]').click();
    await p.locator('[data-act=pre-scale][data-d="-0.05"]').click();
    check('pre-ride intensity stepper shows 95%', (await p.textContent('.screen')).includes('95%'));
    check('preview lists steps in plain words', /3 × 12:00 @ 90%, 5:00 easy between/.test(await p.textContent('.steps')), await p.textContent('.steps'));
    await p.getByRole('button', { name: 'Start', exact: true }).click();
    check('starting without an FTP opens the "Set FTP first" sheet', /Set FTP first/.test(await p.textContent('#sheet')) && (await p.getByRole('button', { name: 'Ramp Test' }).count()) === 1);
    await p.getByRole('button', { name: 'Set it by hand' }).click();
    check('hand stepper starts at 200', (await p.textContent('#sheet')).includes('Use 200'));
    await p.locator('[data-act=hand][data-d="10"]').click();
    await p.locator('[data-act=hand][data-d="-1"]').click();
    await p.getByRole('button', { name: 'Use 209' }).click();
    await p.waitForFunction(() => window.__erg.state.screen === 'ride');
    check('hand-set FTP is stored and the ride starts', await p.evaluate(() => window.__erg.state.ftp === 209 && window.__erg.state.ftpSource.kind === 'manual'));
    check('pre-ride intensity carried into the ride (95%)', (await p.textContent('#rBadge')) === '95%', await p.textContent('#rBadge'));
    const first = await p.evaluate(() => window.__erg.state.trainer.log[0]);
    check('first target = 50% of FTP x 95% = ' + Math.round(0.5 * 209 * 0.95), first.value === Math.round(0.5 * 209 * 0.95), JSON.stringify(first));

    // layout: landscape then portrait, clock paused so nothing moves
    await p.locator('#bPause').click();
    check('Pause relabels to Resume', (await p.textContent('#bPause')) === 'Resume');
    const layout = async () => p.evaluate(() => {
      const fs = parseFloat(getComputedStyle(document.getElementById('vT')).fontSize);
      const btns = [...document.querySelectorAll('.r-btns .btn')].filter(b => getComputedStyle(b).visibility !== 'hidden').map(b => b.getBoundingClientRect().height);
      const r = document.getElementById('vT').getBoundingClientRect();
      return { fs, innerH: innerHeight, minBtn: Math.min(...btns), overflowX: document.documentElement.scrollWidth > innerWidth, inView: r.top >= 0 && r.bottom <= innerHeight };
    });
    const land = await layout();
    check('landscape: numerals >= 22vh tall (digit height ~0.7 x font size)', land.fs * 0.7 >= 0.22 * land.innerH, JSON.stringify(land));
    check('landscape: buttons >= 64 px, no sideways scroll, numerals on screen', land.minBtn >= 64 && !land.overflowX && land.inView, JSON.stringify(land));
    await p.setViewportSize({ width: 768, height: 1024 });
    const port = await layout();
    check('portrait: buttons >= 64 px, no sideways scroll, numerals on screen', port.minBtn >= 64 && !port.overflowX && port.inView, JSON.stringify(port));
    check('portrait: numerals still big (>= 16vh)', port.fs * 0.7 >= 0.16 * port.innerH, JSON.stringify(port));
    await p.setViewportSize({ width: 1180, height: 820 });
    await p.locator('#bPause').click();

    // skip jumps to the next segment and closes the gap in the timeline
    await p.waitForFunction(() => window.__erg.state.ride.segIndex === 0 && window.__erg.state.ride.elapsed > 20);
    const preSkip = await p.evaluate(() => window.__erg.state.ride.duration);
    await p.locator('#bSkip').click();
    await p.waitForFunction(() => window.__erg.state.ride.segIndex === 1, null, { timeout: 5000 });
    const postSkip = await p.evaluate(() => ({ d: window.__erg.state.ride.duration, s0: window.__erg.state.ride.segments[0].dur, s1: window.__erg.state.ride.segments[1].start }));
    check('Skip cuts the segment short and keeps the timeline continuous', postSkip.d < preSkip && postSkip.s1 === postSkip.s0, JSON.stringify(postSkip));

    // intensity buttons: 5% steps, clamped 50..150%
    await p.locator('#bM').click(); await p.locator('#bM').click();
    check('-5% twice from 95% shows 85%', (await p.textContent('#rBadge')) === '85%', await p.textContent('#rBadge'));
    await p.locator('#bP').click();
    check('+5% shows 90%', (await p.textContent('#rBadge')) === '90%');
    await p.waitForTimeout(700);
    const lastSent = await p.evaluate(() => { const l = window.__erg.state.trainer.log; return l[l.length - 1].value; });
    check('trainer gets the rescaled target (debounced)', lastSent === Math.round(0.9 * 209 * 0.9) || lastSent === Math.round(0.55 * 209 * 0.9), lastSent);

    await p.locator('#bEnd').click();
    check('End needs a second tap ("End ride?")', (await p.textContent('#bEnd')) === 'End ride?' && (await p.evaluate(() => window.__erg.state.screen)) === 'ride');
    await p.locator('#bEnd').click();
    await p.waitForFunction(() => window.__erg.state.screen === 'summary');
    check('End goes to the summary and the ride is saved', (await p.evaluate(() => window.__erg.state.summary.rec.duration)) > 0);
    await p.waitForTimeout(300);
    check('saved ride is in IndexedDB', (await p.evaluate(() => window.__erg.ui.history.length)) === 1);
    check('no text inputs on any screen visited', (await p.locator('input[type=text], input[type=number], textarea').count()) === 0);
    await p.context().close();
  }

  // =========================================================================
  // 4. The Bluetooth driver against a fake Web Bluetooth. A fake clock stands in for the 2 s / 10 s timers.
  // =========================================================================
  const U = core.UUIDS;
  const hx = (...b) => b.map(x => x.toString(16).padStart(2, '0')).join('');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function blePage(tweak) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    await ctx.addInitScript(fakeBluetooth);
    const p = await ctx.newPage();
    watch(p);
    await p.clock.install();
    await p.goto(base + '/index.html?speed=60');
    if (tweak) await p.evaluate(tweak);
    p.run = ms => p.clock.runFor(ms);
    p.bt = fn => p.evaluate(fn);
    return p;
  }
  // power 200 W, cadence 90 rpm, every 40 ms of fake time (keeps the 3-second freshness window happy at speed 60)
  const FEED = () => { setInterval(() => window.__bt.bike && window.__bt.bike.notify([0x44, 0x00, 0xB8, 0x0B, 0xB4, 0x00, 0xC8, 0x00]), 40); };

  {
    const p = await blePage();
    await p.getByRole('button', { name: 'Connect Trainer' }).click();
    await p.run(100);
    check('BLE: connected, trainer name shown', /KICKR CORE 1234/.test(await p.textContent('#trainerName')));
    check('BLE: requestDevice filters on FTMS; HRS, CPS, battery, device info are optional',
      same(await p.bt(() => window.__bt.requests[0]), { filters: [{ services: [U.FTMS] }], optionalServices: [U.HRS, U.CPS, U.BATTERY, U.DEV_INFO] }));
    check('BLE: sequence = connect, service, characteristics, notify control point, notify bike data, request control (00), start (07)',
      same(await p.bt(() => window.__bt.ops), ['connect', 'service ' + U.FTMS, 'char ' + U.INDOOR_BIKE, 'char ' + U.CONTROL_PT, 'notify ' + U.CONTROL_PT, 'notify ' + U.INDOOR_BIKE, 'write 00', 'write 07']),
      JSON.stringify(await p.bt(() => window.__bt.ops)));

    // heart rate strap
    await p.bt(() => { window.__bt.ops.length = 0; });
    await p.getByRole('button', { name: 'Connect Heart Rate' }).click();
    await p.run(100);
    check('BLE: strap request is a plain HRS filter', same(await p.bt(() => window.__bt.requests[1]), { filters: [{ services: [U.HRS] }] }));
    check('BLE: strap only subscribes (no writes)', same(await p.bt(() => window.__bt.ops), ['connect', 'service ' + U.HRS, 'char ' + U.HR_MEAS, 'notify ' + U.HR_MEAS]));
    await p.bt(() => window.__bt.hr.notify([0x00, 142]));
    check('BLE: heart rate u8 parsed', (await p.bt(() => window.__erg.state.live.hr)) === 142);
    await p.bt(() => window.__bt.hr.notify([0x01, 0x2c, 0x01]));
    check('BLE: heart rate u16 parsed', (await p.bt(() => window.__erg.state.live.hr)) === 300);
    await p.bt(() => window.__bt.bike.notify([0x44, 0x02, 0xB8, 0x0B, 0xB4, 0x00, 0xC8, 0x00, 150]));   // flags 0x0244: bike HR 150
    const live = await p.bt(() => ({ pw: window.__erg.state.live.power, cad: window.__erg.state.live.cadence, hr: window.__erg.state.live.hr }));
    check('BLE: bike data parsed (200 W, 90 rpm) and the strap beats the trainer HR', live.pw === 200 && live.cad === 90 && live.hr === 300, JSON.stringify(live));

    // ride with slow writes: commands must queue one at a time, and the newest must win
    await p.bt(() => {
      window.__erg.state.ftp = 250; window.__bt.writeDelay = 600; window.__bt.written.length = 0; window.__bt.ops.length = 0;
      window.__calls = 0; const t = window.__erg.state.trainer, o = t.setTargetPower.bind(t); t.setTargetPower = w => { window.__calls++; o(w); };
    });
    await p.bt(FEED);
    check('BLE: ride starts on the real trainer', await p.bt(() => window.__erg.startWorkout('ss3x12')));
    await p.run(3000);
    const r1 = await p.bt(() => ({ w: window.__bt.written.slice(), calls: window.__calls, over: window.__bt.overlaps, el: window.__erg.state.ride.elapsed,
      s: window.__erg.getSamples().filter(x => x.power === 200 && x.cadence === 90).length }));
    const erg1 = r1.w.filter(x => x.startsWith('05'));
    const first = parseInt(erg1[0].slice(2, 4), 16);   // newest target wins, so by the time the queue gets to it this is a little above 125 W
    check('BLE: Start (07) goes out first, then a warm-up target (125-135 W)', r1.w[0] === '07' && first >= 125 && first <= 135, r1.w.slice(0, 3).join(','));
    check('BLE: targets coalesce while a write is pending (' + erg1.length + ' writes for ' + r1.calls + ' updates)', erg1.length >= 2 && erg1.length < r1.calls, erg1.length + '/' + r1.calls);
    check('BLE: never two GATT operations at once', r1.over === 0, r1.over);
    check('BLE: live data reaches the samples', r1.s > 100 && r1.el > 100, JSON.stringify({ s: r1.s, el: r1.el }));

    await p.bt(() => document.getElementById('bPause').click());
    await p.run(3000);
    const paused = await p.bt(() => ({ w: window.__bt.written.slice(), e: window.__erg.state.ride.elapsed, busy: window.__bt.inflight }));
    check('BLE: Pause sends the light target (40% of FTP = 100 W) and it is the last write', paused.w[paused.w.length - 1] === hx(0x05, 100, 0) && paused.busy === 0, paused.w.slice(-2).join(','));
    await p.run(1000);
    check('BLE: the clock stops while paused', (await p.bt(() => window.__erg.state.ride.elapsed)) === paused.e);
    const n100 = (await p.bt(() => window.__bt.written)).filter(x => x === hx(0x05, 100, 0)).length;
    await p.run(10500);
    check('BLE: keepalive re-sends the current target every 10 s', (await p.bt(() => window.__bt.written)).filter(x => x === hx(0x05, 100, 0)).length > n100);
    await p.bt(() => { window.__bt.writeDelay = 0; document.getElementById('bPause').click(); });
    await p.run(1500);
    const resumed = await p.bt(() => window.__bt.written.slice(-4));
    check('BLE: Resume sends the real target again', resumed.some(x => x.startsWith('05') && x !== hx(0x05, 100, 0)), resumed.join(','));

    // dropout while riding: the clock keeps going, one retry fails, then the whole sequence runs again
    const e0 = await p.bt(() => window.__erg.state.ride.elapsed);
    await p.bt(() => { window.__bt.ops.length = 0; window.__bt.written.length = 0; window.__bt.connectFails = 1; window.__bt.drop(); });
    await p.run(100);
    check('BLE: dropout shows "Trainer disconnected, reconnecting…"', (await p.textContent('#toast')).includes('Trainer disconnected, reconnecting…'));
    await p.run(4300);
    const re = await p.bt(() => ({ ops: window.__bt.ops.slice(), w: window.__bt.written.slice(), e: window.__erg.state.ride.elapsed, st: window.__erg.state.trainer.state }));
    check('BLE: reconnected on the second try, sequence redone, target re-sent',
      re.st === 'connected' && re.ops.filter(o => o === 'connect').length === 2 && re.w[0] === '00' && re.w[1] === '07' && re.w.slice(2).some(x => x.startsWith('05')) && (await p.textContent('#toast')).includes('Trainer reconnected'),
      JSON.stringify(re));
    check('BLE: the workout clock did not pause during the dropout', re.e - e0 > 200, re.e - e0);

    // give up after 10 tries, then the Reconnect button
    await p.bt(() => { window.__bt.connects = 0; window.__bt.connectFails = 99; window.__bt.drop(); });
    await p.run(22500);
    check('BLE: gives up after 10 tries, 2 s apart', (await p.bt(() => window.__bt.connects)) === 10, await p.bt(() => window.__bt.connects));
    check('BLE: shows "Trainer lost. Tap Reconnect." with a button', (await p.textContent('#toast')).includes('Trainer lost. Tap Reconnect.') && (await p.getByRole('button', { name: 'Reconnect' }).count()) === 1);
    check('BLE: the ride is still running while the trainer is lost', await p.bt(() => !window.__erg.state.ride.finished && window.__erg.state.screen === 'ride'));
    await p.bt(() => { window.__bt.connectFails = 0; });
    await p.getByRole('button', { name: 'Reconnect' }).click();
    await p.run(2500);
    check('BLE: Reconnect brings the trainer back', (await p.bt(() => window.__erg.state.trainer.state)) === 'connected' && (await p.textContent('#toast')).includes('Trainer reconnected'));
    check('BLE: no overlapping GATT operations in the whole session, only 128-bit UUID strings',
      (await p.bt(() => window.__bt.overlaps)) === 0 && same(await p.bt(() => window.__bt.badUuids), []));
    await p.context().close();
  }

  {   // free-ride segment: Set Indoor Bike Simulation, via writeValue when there is no writeValueWithResponse
    const p = await blePage(() => { window.__bt.noWriteWithResponse = true; });
    await p.getByRole('button', { name: 'Connect Trainer' }).click();
    await p.run(100);
    await p.bt(() => { window.__erg.state.ftp = 250; window.__bt.written.length = 0; });
    await p.bt(FEED);
    check('BLE: 20-minute test starts', await p.bt(() => window.__erg.startWorkout('ftp20')));
    await p.run(21500);                                   // ~1290 ride-seconds: inside the first free segment (starts at 1260)
    const f1 = await p.bt(() => ({ w: window.__bt.written.slice(), badge: document.getElementById('rBadge').textContent, bp: document.getElementById('bP').textContent,
      said: window.__erg.spoken.slice(-3), uwv: window.__bt.usedWriteValue }));
    check('BLE: writeValue is used when writeValueWithResponse is missing', f1.uwv > 0 && f1.w.length > 0, f1.uwv);
    check('BLE: free segment sends Set Indoor Bike Simulation, grade 2.0 % (11 00 00 c8 00 28 33)', f1.w.includes(hx(0x11, 0, 0, 0xc8, 0, 40, 51)), f1.w.slice(-3).join(','));
    check('BLE: free segment shows the grade badge and Grade buttons, and speaks the cue', f1.badge === 'Grade 2.0%' && f1.bp === 'Grade +0.5' && f1.said.includes('Five minutes, hard.'), JSON.stringify(f1));
    await p.bt(() => document.getElementById('bP').click());
    await p.run(500);
    check('BLE: Grade +0.5 sends 2.5 % (11 00 00 fa 00 28 33) after the 300 ms debounce', (await p.bt(() => window.__bt.written)).includes(hx(0x11, 0, 0, 0xfa, 0, 40, 51)));
    check('BLE: Free-segment average power is shown', /Average \d+ W/.test(await p.textContent('#vN')), await p.textContent('#vN'));
    check('BLE: no overlapping GATT operations', (await p.bt(() => window.__bt.overlaps)) === 0);
    await p.context().close();
  }

  {   // control point says "control not permitted", then never answers at all
    const p = await blePage(() => { window.__bt.cpResult = 0x05; });
    await p.getByRole('button', { name: 'Connect Trainer' }).click();
    await p.run(100);
    check('BLE: result 0x05 tells you to close the Wahoo app / Zwift and power-cycle the trainer',
      (await p.textContent('#toast')).includes('Another app has control of the trainer. Close the Wahoo app / Zwift, turn the trainer off and on, then reconnect.'));
    await p.bt(() => { window.__bt.cpResult = 1; window.__bt.cpSilent = true; });
    await p.getByRole('button', { name: 'Connect Trainer' }).click();
    await p.run(3200);
    check('BLE: no reply to the control request after 3 s: carry on and say so', /did not answer/.test(await p.textContent('#toast')) && /Connected to/.test(await p.textContent('#status')),
      await p.textContent('#toast'));
    await p.context().close();
  }

  check('no page errors or console errors', problems.length === 0, problems.join(' | '));
  await browser.close();
}

main().catch(e => { failures++; console.log('FAIL e2e crashed  -> ' + (e && e.stack || e)); }).finally(() => {
  server.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});

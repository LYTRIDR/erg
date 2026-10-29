/* ERG core: pure logic, no DOM, no timers, no network.
 * Exposed as globalThis.ERGCore (browser) and module.exports (Node tests). */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Bluetooth UUIDs. Always full 128-bit lowercase strings (Bluefy's polyfill
  // chokes on numeric UUIDs and BluetoothUUID.*).
  // ---------------------------------------------------------------------------
  const UUIDS = {
    FTMS:         '00001826-0000-1000-8000-00805f9b34fb',
    INDOOR_BIKE:  '00002ad2-0000-1000-8000-00805f9b34fb', // notify
    CONTROL_PT:   '00002ad9-0000-1000-8000-00805f9b34fb', // write + indicate
    FTMS_STATUS:  '00002ada-0000-1000-8000-00805f9b34fb', // notify (optional)
    FTMS_FEATURE: '00002acc-0000-1000-8000-00805f9b34fb', // read (optional)
    POWER_RANGE:  '00002ad8-0000-1000-8000-00805f9b34fb', // read (optional)
    HRS:          '0000180d-0000-1000-8000-00805f9b34fb',
    HR_MEAS:      '00002a37-0000-1000-8000-00805f9b34fb',
    CPS:          '00001818-0000-1000-8000-00805f9b34fb', // optional fallback
    CP_MEAS:      '00002a63-0000-1000-8000-00805f9b34fb',
    BATTERY:      '0000180f-0000-1000-8000-00805f9b34fb',
    DEV_INFO:     '0000180a-0000-1000-8000-00805f9b34fb'
  };

  // FTMS control point result codes (byte 2 of a 0x80 response).
  const CP_RESULT = { SUCCESS: 0x01, NOT_SUPPORTED: 0x02, INVALID_PARAMETER: 0x03, FAILED: 0x04, NOT_PERMITTED: 0x05 };

  // Accept a DataView, ArrayBuffer, typed array / Buffer, or plain array of bytes.
  function asView(x) {
    if (x instanceof DataView) return x;
    if (x instanceof ArrayBuffer) return new DataView(x);
    if (x && x.buffer instanceof ArrayBuffer) return new DataView(x.buffer, x.byteOffset, x.byteLength);
    if (Array.isArray(x)) return new DataView(Uint8Array.from(x).buffer);
    throw new TypeError('expected a DataView');
  }

  // ---------------------------------------------------------------------------
  // Parsers. Everything is little-endian. Short packets never throw.
  // ---------------------------------------------------------------------------

  // FTMS Indoor Bike Data (0x2AD2). Flags u16 at byte 0, then the fields whose
  // flag bit is set, in this fixed order. Bit 0 is inverted: "More Data" == 0
  // means Instantaneous Speed IS present.
  const BIKE_FIELDS = [
    // [key, present(flags), size in bytes, read(dv, offset)]
    ['speed',      f => !(f & 0x0001), 2, (d, o) => d.getUint16(o, true) / 100],   // km/h
    ['avgSpeed',   f => f & 0x0002,    2, (d, o) => d.getUint16(o, true) / 100],
    ['cadence',    f => f & 0x0004,    2, (d, o) => d.getUint16(o, true) / 2],     // rpm
    ['avgCadence', f => f & 0x0008,    2, (d, o) => d.getUint16(o, true) / 2],
    ['distance',   f => f & 0x0010,    3, (d, o) => d.getUint16(o, true) + d.getUint8(o + 2) * 65536], // u24 m
    ['resistance', f => f & 0x0020,    2, (d, o) => d.getInt16(o, true)],
    ['power',      f => f & 0x0040,    2, (d, o) => d.getInt16(o, true)],          // W
    ['avgPower',   f => f & 0x0080,    2, (d, o) => d.getInt16(o, true)],
    ['energy',     f => f & 0x0100,    5, (d, o) => ({ total: d.getUint16(o, true), perHour: d.getUint16(o + 2, true), perMin: d.getUint8(o + 4) })],
    ['hr',         f => f & 0x0200,    1, (d, o) => d.getUint8(o)],
    ['met',        f => f & 0x0400,    1, (d, o) => d.getUint8(o) / 10],
    ['elapsed',    f => f & 0x0800,    2, (d, o) => d.getUint16(o, true)],         // s
    ['remaining',  f => f & 0x1000,    2, (d, o) => d.getUint16(o, true)]
  ];

  function parseIndoorBikeData(data) {
    const dv = asView(data);
    const out = {};
    for (const f of BIKE_FIELDS) out[f[0]] = undefined;
    if (dv.byteLength < 2) return out;
    const flags = dv.getUint16(0, true);
    let o = 2;
    for (const [key, present, size, read] of BIKE_FIELDS) {
      if (!present(flags)) continue;
      if (o + size > dv.byteLength) break; // truncated packet: keep what we have
      out[key] = read(dv, o);
      o += size;
    }
    return out;
  }

  // Heart Rate Measurement (0x2A37): flags u8; bit 0 set = HR is u16, else u8.
  function parseHeartRate(data) {
    const dv = asView(data);
    if (dv.byteLength < 2) return null;
    if (dv.getUint8(0) & 1) return dv.byteLength >= 3 ? dv.getUint16(1, true) : null;
    return dv.getUint8(1);
  }

  // Cycling Power Measurement (0x2A63): flags u16, instantaneous power s16.
  function parseCyclingPower(data) {
    const dv = asView(data);
    return { power: dv.byteLength >= 4 ? dv.getInt16(2, true) : undefined };
  }

  // FTMS Control Point response: [0x80, requestOpcode, resultCode].
  function parseControlPointResponse(data) {
    const dv = asView(data);
    const b = i => (i < dv.byteLength ? dv.getUint8(i) : undefined);
    const result = b(2);
    return { opcode: b(0), requestOpcode: b(1), result, ok: result === CP_RESULT.SUCCESS };
  }

  // ---------------------------------------------------------------------------
  // Encoders (FTMS control point commands). All return Uint8Array.
  // ---------------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, dflt) => (typeof v === 'number' && isFinite(v) ? v : dflt);
  // signed 16-bit little-endian as two bytes (two's complement via bit ops)
  function s16(v) { v = clamp(Math.round(v), -32768, 32767); return [v & 0xff, (v >> 8) & 0xff]; }

  const encRequestControl = () => Uint8Array.of(0x00);
  const encReset = () => Uint8Array.of(0x01);
  const encStart = () => Uint8Array.of(0x07);
  const encStop = () => Uint8Array.of(0x08, 0x01);

  // 0x05 Set Target Power: int16 watts, clamped 0..2000.
  function encSetTargetPower(watts) {
    const w = clamp(Math.round(num(watts, 0)), 0, 2000);
    return Uint8Array.of(0x05, w & 0xff, (w >> 8) & 0xff);
  }

  // 0x11 Set Indoor Bike Simulation: wind s16 (0.001 m/s), grade s16 (0.01 %),
  // crr u8 (0.0001), cw u8 (0.01 kg/m). Grade 1.5 % -> 150 -> 0x96 0x00.
  function encSetSim(opts) {
    const o = opts || {};
    const grade = clamp(num(o.grade, 0), -10, 20);
    const wind = num(o.windMs, 0);
    const crr = num(o.crr, 0.004);
    const cw = num(o.cw, 0.51);
    return Uint8Array.of(
      0x11,
      ...s16(wind * 1000),
      ...s16(grade * 100),
      clamp(Math.round(crr / 0.0001), 0, 255),
      clamp(Math.round(cw / 0.01), 0, 255)
    );
  }

  // ---------------------------------------------------------------------------
  // Zones (Coggan, by fraction of FTP)
  // ---------------------------------------------------------------------------
  const ZONES = [
    { z: 1, name: 'Recovery',  color: '#7f8c99', max: 0.55 },
    { z: 2, name: 'Endurance', color: '#3b8bd4', max: 0.76 },
    { z: 3, name: 'Tempo',     color: '#36b37e', max: 0.91 },
    { z: 4, name: 'Threshold', color: '#e8c23a', max: 1.06 },
    { z: 5, name: 'VO2 Max',   color: '#f28c28', max: 1.21 },
    { z: 6, name: 'Anaerobic', color: '#e5484d', max: Infinity }
  ];

  function zoneOf(pct) {
    const p = num(pct, 0);
    const zn = ZONES.find(z => p < z.max);
    return { z: zn.z, name: zn.name, color: zn.color };
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers (pure, shared by the UI and the tests)
  // ---------------------------------------------------------------------------
  const p2 = n => String(n).padStart(2, '0');

  // 'm:ss' under an hour, 'h:mm:ss' from an hour up.
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(num(sec, 0)));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + p2(m) + ':' + p2(s) : m + ':' + p2(s);
  }

  // Library cards: 3900 s -> '1:05' (hours:minutes).
  function fmtHM(sec) {
    const mins = Math.round(num(sec, 0) / 60);
    return Math.floor(mins / 60) + ':' + p2(mins % 60);
  }

  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ride';
  }

  // ---------------------------------------------------------------------------
  // Workout flattening
  // ---------------------------------------------------------------------------
  const FREE_PCT = 0.75;          // free segments count at 75 % FTP for IF/TSS and for drawing
  const RAMPTEST_SECONDS = 1500;  // placeholder; the engine ends the ramp test dynamically
  const RAMPTEST_FROM = 0.4;      // nominal fractions, used only to draw the ramp-test card
  const RAMPTEST_TO = 1.3;
  const EASY_MAX = 0.60;          // at or below this fraction of FTP a segment is "easy"

  // Mean of x^4 for x moving linearly from a to b (exact integral).
  function mean4(a, b) {
    return a === b ? Math.pow(a, 4) : (Math.pow(b, 5) - Math.pow(a, 5)) / (5 * (b - a));
  }

  function labelFor(seg, i, count) {
    if (seg.kind === 'ramptest') return 'Ramp test';
    if (seg.kind === 'free') return 'Free ride';
    if (i === 0 && seg.to > seg.from) return 'Warm-up';
    if (i === count - 1 && seg.to < seg.from) return 'Cool-down';
    return Math.max(seg.from, seg.to) <= EASY_MAX ? 'Easy' : 'Work';
  }

  /* Expand a workout into a flat list of segments.
   * segment = {start, dur, kind:'erg'|'ramp'|'free'|'ramptest', from, to, cue, zone, label,
   *            idx, rest, grade?}   (from/to are fractions of FTP; free has grade)
   * Returns {segments, duration, ifEstimate, tssEstimate, kind} where kind is
   * 'ramp' | '20min' | 'free' | 'workout' (what the workout is, for the engine). */
  function flattenWorkout(workout, ftp) {
    if (!workout || !Array.isArray(workout.steps)) throw new Error('Workout has no steps');
    const id = workout.id || workout.name || '?';
    const segs = [];
    let t = 0;
    const push = seg => { seg.start = t; t += seg.dur; segs.push(seg); };
    const need = (v, what) => {
      if (typeof v !== 'number' || !isFinite(v)) throw new Error(id + ': bad ' + what);
      return v;
    };

    function walk(steps, depth) {
      if (!Array.isArray(steps) || depth > 6) throw new Error(id + ': bad steps');
      for (const s of steps) {
        if (Array.isArray(s)) {                       // [seconds, pct] or [seconds, from, to, cue]
          const dur = need(s[0], 'duration');
          if (dur <= 0) throw new Error(id + ': duration must be positive');
          const from = need(s[1], 'percent');
          const to = s[2] == null ? from : need(s[2], 'percent');
          push({ dur, kind: to === from ? 'erg' : 'ramp', from, to, cue: s[3] || null });
        } else if (s && typeof s === 'object' && 'reps' in s) {   // repeat block (may nest)
          const n = need(s.reps, 'reps');
          if (n < 1 || n > 200 || Math.floor(n) !== n) throw new Error(id + ': bad reps');
          for (let i = 0; i < n; i++) walk(s.steps, depth + 1);
        } else if (s && typeof s === 'object' && 'free' in s) {   // free ride in sim mode
          const dur = need(s.free, 'free duration');
          if (dur <= 0) throw new Error(id + ': duration must be positive');
          push({ dur, kind: 'free', from: FREE_PCT, to: FREE_PCT, cue: s.cue || null, grade: num(s.grade, 0) });
        } else if (s && typeof s === 'object' && s.ramptest) {
          push({ dur: RAMPTEST_SECONDS, kind: 'ramptest', from: RAMPTEST_FROM, to: RAMPTEST_TO, cue: null });
        } else {
          throw new Error(id + ': unknown step');
        }
      }
    }
    walk(workout.steps, 0);
    if (!segs.length) throw new Error(id + ': empty workout');

    let sum4 = 0;
    segs.forEach((s, i) => {
      s.idx = i;
      s.zone = zoneOf((s.from + s.to) / 2);
      s.label = labelFor(s, i, segs.length);
      s.rest = s.label === 'Easy' || s.label === 'Cool-down';
      sum4 += s.dur * mean4(s.from, s.to);
    });
    const duration = t;
    const ifEstimate = Math.sqrt(Math.sqrt(sum4 / duration));
    const tssEstimate = duration * ifEstimate * ifEstimate / 3600 * 100;

    let kind = 'workout';
    if (segs.some(s => s.kind === 'ramptest')) kind = 'ramp';
    else if (workout.cat === 'test') kind = '20min';
    else if (segs.every(s => s.kind === 'free')) kind = 'free';
    return { segments: segs, duration, ifEstimate, tssEstimate, kind };
  }

  // The segment that contains second t, or null (after the end).
  function segmentAt(segments, t) {
    for (const s of segments) if (t >= s.start && t < s.start + s.dur) return s;
    return null;
  }

  // Watts wanted at elapsed second t. Ramps interpolate linearly, result rounded to 1 W,
  // times scale (intensity, default 1). null during free segments (or without an FTP).
  // Ramp-test segments follow rampTestTargetAt() and ignore scale/ftp.
  function targetAt(segments, t, ftp, scale) {
    const seg = segmentAt(segments, t);
    if (!seg || seg.kind === 'free') return null;
    if (seg.kind === 'ramptest') return rampTestTargetAt(t - seg.start);
    if (!ftp) return null;
    const k = scale == null ? 1 : scale;
    const f = seg.kind === 'ramp' ? (t - seg.start) / seg.dur : 0;
    return Math.round((seg.from + (seg.to - seg.from) * f) * ftp * k);
  }

  // The 20-minute test effort inside a '20min' workout: its last long free segment.
  function twentyMinuteEffort(segments) {
    let found = null;
    for (const s of segments) if (s.kind === 'free' && s.dur >= 1200) found = s;
    return found;
  }

  // ---------------------------------------------------------------------------
  // Plain-words step list for the Preview screen
  // ---------------------------------------------------------------------------
  function wattsText(from, to, ftp) {
    const f = ftp ? v => Math.round(v * ftp) : v => Math.round(v * 100);
    const unit = ftp ? ' W' : '%';
    return (to == null || to === from) ? f(from) + unit : f(from) + '–' + f(to) + unit;
  }
  const stepTo = s => (s[2] == null ? s[1] : s[2]);
  const isEasyStep = s => Array.isArray(s) && Math.max(s[1], stepTo(s)) <= EASY_MAX;

  // "12:00 @ 225 W" or "5:00 easy"
  function stepCore(s, ftp) {
    return fmtClock(s[0]) + (isEasyStep(s) ? ' easy' : ' @ ' + wattsText(s[1], stepTo(s), ftp));
  }

  function describeBlock(b, ftp, lines) {
    const inner = b.steps;
    const last = inner[inner.length - 1];
    // [work, easy] -> "3 x 12:00 @ 225 W, 5:00 easy between"
    if (inner.length === 2 && Array.isArray(inner[0]) && isEasyStep(last) && !isEasyStep(inner[0])) {
      lines.push(b.reps + ' × ' + stepCore(inner[0], ftp) + ', ' + fmtClock(last[0]) + ' easy between');
      return;
    }
    // [nested block, easy] -> sets with easy between, nested block on its own line
    if (inner.length === 2 && inner[0] && inner[0].reps && isEasyStep(last)) {
      lines.push(b.reps + ' sets, ' + fmtClock(last[0]) + ' easy between sets');
      const sub = [];
      describeBlock(inner[0], ftp, sub);
      lines.push('Each set: ' + sub.join(' '));
      return;
    }
    const parts = [];
    for (const x of inner) {
      if (Array.isArray(x)) parts.push(stepCore(x, ftp));
      else if (x && x.reps) { const sub = []; describeBlock(x, ftp, sub); parts.push(sub.join(' ')); }
    }
    lines.push(b.reps + ' × (' + parts.join(', ') + ')');
  }

  function describeWorkout(workout, ftp) {
    const lines = [];
    const steps = workout.steps;
    steps.forEach((s, i) => {
      if (Array.isArray(s)) {
        const to = stepTo(s);
        let txt;
        if (to !== s[1]) {
          const kindWord = i === 0 && to > s[1] ? 'warm-up' : (i === steps.length - 1 && to < s[1] ? 'cool-down' : 'ramp');
          txt = fmtClock(s[0]) + ' ' + kindWord + ', ' + wattsText(s[1], to, ftp);
        } else {
          txt = stepCore(s, ftp);
        }
        if (s[3]) txt += ' — ' + s[3];
        lines.push(txt);
      } else if (s && s.reps) {
        describeBlock(s, ftp, lines);
      } else if (s && s.free) {
        lines.push(fmtClock(s.free) + ' free ride, grade ' + num(s.grade, 0) + '%' + (s.cue ? ' — ' + s.cue : ''));
      } else if (s && s.ramptest) {
        lines.push('Start at 100 W, add 20 W every minute until you can’t hold it');
      }
    });
    return lines;
  }

  // ---------------------------------------------------------------------------
  // "Suggested" badge on the Library: Ramp Test when there is no FTP or the last
  // test is older than 56 days; otherwise rotate by the category of the last ride.
  // ctx = {ftp, lastTestAt (ms|null), lastCat, rideCount, now (ms)}
  // ---------------------------------------------------------------------------
  const SUGGEST_NEXT = {
    recovery:  ['sweetspot'],
    sweetspot: ['endurance'],
    endurance: ['threshold', 'vo2'],      // alternate
    threshold: ['recovery', 'endurance'], // alternate
    vo2:       ['recovery', 'endurance']
  };
  const SUGGEST_PICK = { recovery: 'rec30', sweetspot: 'ss3x12', endurance: 'end60', threshold: 'thr3x10', vo2: 'vo2_4x4' };

  function suggestWorkoutId(ctx) {
    const c = ctx || {};
    const now = num(c.now, Date.now());
    const ageDays = c.lastTestAt ? (now - c.lastTestAt) / 86400000 : Infinity;
    if (!c.ftp || ageDays > 56) return 'ramp';
    const options = SUGGEST_NEXT[c.lastCat] || ['endurance'];
    return SUGGEST_PICK[options[(c.rideCount || 0) % options.length]];
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  const val = v => (typeof v === 'number' && isFinite(v) ? v : 0);   // null/NaN power counts as 0 W
  const isNum = v => typeof v === 'number' && isFinite(v);

  // Best rolling average over w samples, or null when the ride is shorter than w.
  function bestRolling(arr, w) {
    if (arr.length < w) return null;
    let sum = 0;
    for (let i = 0; i < w; i++) sum += arr[i];
    let best = sum;
    for (let i = w; i < arr.length; i++) {
      sum += arr[i] - arr[i - w];
      if (sum > best) best = sum;
    }
    return best / w;
  }

  // Normalized power: 30-s rolling mean, 4th power, mean, 4th root. Needs >= 30 samples,
  // otherwise falls back to the plain average. (sqrt(sqrt()) keeps constant rides exact.)
  function normalizedPower(pw, avg) {
    if (pw.length < 30) return avg;
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += pw[i];
    let acc = 0, count = 0;
    for (let i = 29; i < pw.length; i++) {
      if (i > 29) sum += pw[i] - pw[i - 30];
      const a = sum / 30, a2 = a * a;
      acc += a2 * a2;
      count++;
    }
    return Math.sqrt(Math.sqrt(acc / count));
  }

  /* samples are 1 Hz {t, target, power, cadence, hr}; power/cadence/hr may be null.
   * Null power counts as 0 W; null cadence/HR are skipped in their averages. */
  function computeMetrics(samples, ftp, opts) {
    const isRampTest = !!(opts && opts.isRampTest);
    const n = samples.length;
    const pw = samples.map(s => val(s.power));
    const sum = pw.reduce((a, b) => a + b, 0);
    const avgPower = n ? sum / n : 0;
    const cads = samples.filter(s => isNum(s.cadence)).map(s => s.cadence);
    const hrs = samples.filter(s => isNum(s.hr)).map(s => s.hr);
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

    const np = n ? normalizedPower(pw, avgPower) : 0;
    const hasFtp = isNum(ftp) && ftp > 0;
    const ifv = hasFtp ? np / ftp : null;
    const tss = hasFtp ? n * np * ifv / (ftp * 3600) * 100 : null;
    const best = { p60: bestRolling(pw, 60), p300: bestRolling(pw, 300), p1200: bestRolling(pw, 1200) };
    let eftp = null;
    if (isRampTest) eftp = best.p60 == null ? null : Math.round(0.75 * best.p60);
    else if (best.p1200 != null) eftp = Math.round(0.95 * best.p1200);

    return {
      avgPower,
      maxPower: n ? Math.max.apply(null, pw) : 0,
      avgCadence: mean(cads),
      avgHr: mean(hrs),
      maxHr: hrs.length ? Math.max.apply(null, hrs) : null,
      duration: n,
      kj: sum / 1000,
      np,
      if: ifv,
      tss,
      best,
      eftp
    };
  }

  // ---------------------------------------------------------------------------
  // Ramp test helpers
  // ---------------------------------------------------------------------------
  const RAMP_START_W = 100, RAMP_STEP_W = 20, RAMP_STEP_S = 60, RAMP_MAX_STEPS = 40;

  // Step k = floor(t / 60); target = 100 + 20 k watts. Needs no FTP. Capped at 40 steps.
  function rampTestTargetAt(t) {
    const k = clamp(Math.floor(num(t, 0) / RAMP_STEP_S), 0, RAMP_MAX_STEPS - 1);
    return RAMP_START_W + RAMP_STEP_W * k;
  }

  /* feed({t, target, power, cadence}) -> true once the rider has failed. Three rules, each with
   * its own counter that resets when the condition clears:
   *   1. cadence < 50 rpm for 6 samples in a row — armed only once the rider has clearly been
   *      pedaling (cadence >= 60 seen) or after t >= 60 s, so clipping in slowly at the start
   *      can't end the test
   *   2. power < 85 % of target for 15 samples in a row, counted only from t >= 180 s
   *   3. cadence === 0 or power missing for 6 samples in a row, counted only from t >= 60 s
   * Once failed it stays failed until reset(). */
  function rampFailureDetector() {
    let lowCadence = 0, lowPower = 0, dead = 0, failed = false, reason = null, armed = false;
    return {
      feed(s) {
        if (failed) return true;
        const t = num(s.t, 0);
        const cad = isNum(s.cadence) ? s.cadence : null;
        const pow = isNum(s.power) ? s.power : null;
        if ((cad !== null && cad >= 60) || t >= 60) armed = true;
        lowCadence = (armed && cad !== null && cad < 50) ? lowCadence + 1 : 0;
        lowPower = (t >= 180 && val(pow) < 0.85 * s.target) ? lowPower + 1 : 0;
        dead = (t >= 60 && (cad === 0 || pow === null)) ? dead + 1 : 0;
        if (lowCadence >= 6) { failed = true; reason = 'cadence'; }
        else if (lowPower >= 15) { failed = true; reason = 'power'; }
        else if (dead >= 6) { failed = true; reason = 'no data'; }
        return failed;
      },
      get failed() { return failed; },
      get reason() { return reason; },
      reset() { lowCadence = lowPower = dead = 0; failed = false; reason = null; armed = false; }
    };
  }

  // FTP from a ramp test = 75 % of the best 60-second power. null if under a minute of data.
  function rampResult(samples) {
    const bestMinute = bestRolling(samples.map(s => val(s.power)), 60);
    return { ftp: bestMinute == null ? null : Math.round(0.75 * bestMinute), bestMinute };
  }

  // ---------------------------------------------------------------------------
  // TCX export (Garmin TCX v2, power in the TPX extension)
  // ---------------------------------------------------------------------------
  const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  const xmlEscape = s => String(s).replace(/[&<>"']/g, c => XML_ESC[c]);
  const isoZ = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (isNum(v)) return v;
    const p = typeof v === 'string' ? Date.parse(v) : NaN;
    return isNaN(p) ? Date.now() : p;
  }
  const rideName = r => r.name || (r.workout && r.workout.name) || 'Ride';

  // ride = {startedAt (ms | ISO string | Date), name (or workout.name), duration?, samples[]}
  // One Trackpoint per sample; HeartRateBpm / Cadence are left out when null.
  function toTCX(ride) {
    const samples = ride.samples || [];
    const startMs = toMs(ride.startedAt);
    const start = isoZ(startMs);
    const total = Math.round(isNum(ride.duration) ? ride.duration : samples.length);
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"',
      '  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">',
      '  <Activities><Activity Sport="Biking">',
      '    <Id>' + start + '</Id>',
      '    <Lap StartTime="' + start + '">',
      '      <TotalTimeSeconds>' + total + '</TotalTimeSeconds><DistanceMeters>0</DistanceMeters>',
      '      <Calories>0</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>',
      '      <Track>'
    ];
    samples.forEach((s, i) => {
      let tp = '        <Trackpoint><Time>' + isoZ(startMs + num(s.t, i) * 1000) + '</Time>';
      if (isNum(s.hr) && s.hr > 0) tp += '<HeartRateBpm><Value>' + Math.round(s.hr) + '</Value></HeartRateBpm>';
      if (isNum(s.cadence)) tp += '<Cadence>' + clamp(Math.round(s.cadence), 0, 254) + '</Cadence>';
      tp += '<Extensions><ns3:TPX><ns3:Watts>' + Math.max(0, Math.round(val(s.power))) + '</ns3:Watts></ns3:TPX></Extensions></Trackpoint>';
      out.push(tp);
    });
    out.push(
      '      </Track>',
      '    </Lap>',
      '    <Notes>ERG: ' + xmlEscape(rideName(ride)) + '</Notes>',
      '  </Activity></Activities>',
      '</TrainingCenterDatabase>'
    );
    return out.join('\n') + '\n';
  }

  // 'erg-2026-10-29-sweet-spot-3x12.tcx' (date is the local date the ride started)
  function tcxFilename(ride) {
    const d = new Date(toMs(ride.startedAt));
    return 'erg-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '-' + slug(rideName(ride)) + '.tcx';
  }

  // ---------------------------------------------------------------------------
  const ERGCore = {
    UUIDS, CP_RESULT, ZONES,
    parseIndoorBikeData, parseHeartRate, parseCyclingPower, parseControlPointResponse,
    encRequestControl, encReset, encStart, encStop, encSetTargetPower, encSetSim,
    zoneOf, flattenWorkout, segmentAt, targetAt, twentyMinuteEffort, describeWorkout, suggestWorkoutId,
    computeMetrics, rampTestTargetAt, rampFailureDetector, rampResult,
    toTCX, tcxFilename, xmlEscape, fmtClock, fmtHM, slug, bestRolling
  };
  root.ERGCore = ERGCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = ERGCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);

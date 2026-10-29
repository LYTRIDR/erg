'use strict';
// Unit tests for core.js. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const { WORKOUTS, WORKOUT_CATEGORIES } = require('../workouts.js');

const byId = id => WORKOUTS.find(w => w.id === id);
const dv = bytes => new DataView(Uint8Array.from(bytes).buffer);
const le16 = v => [v & 0xff, (v >> 8) & 0xff];
const arr = u8 => Array.from(u8);

// ---------------------------------------------------------------------------
test('globalThis.ERGCore is set and UUIDs are full 128-bit lowercase strings', () => {
  assert.equal(globalThis.ERGCore, C);
  for (const [name, u] of Object.entries(C.UUIDS)) {
    assert.match(u, /^[0-9a-f]{8}-0000-1000-8000-00805f9b34fb$/, name);
  }
  assert.equal(C.UUIDS.FTMS, '00001826-0000-1000-8000-00805f9b34fb');
  assert.equal(C.UUIDS.CONTROL_PT, '00002ad9-0000-1000-8000-00805f9b34fb');
});

// ---------------------------------------------------------------------------
// Indoor Bike Data
test('parseIndoorBikeData: flags 0x0044 = speed + cadence + power', () => {
  const p = dv([0x44, 0x00, ...le16(3000), ...le16(180), ...le16(250)]);
  const r = C.parseIndoorBikeData(p);
  assert.equal(r.speed, 30);
  assert.equal(r.cadence, 90);
  assert.equal(r.power, 250);
  assert.equal(r.hr, undefined);
  assert.equal(r.distance, undefined);
  assert.equal(r.avgPower, undefined);
});

test('parseIndoorBikeData: flags 0x0244 adds heart rate', () => {
  const p = dv([0x44, 0x02, ...le16(2500), ...le16(176), ...le16(210), 141]);
  const r = C.parseIndoorBikeData(p);
  assert.equal(r.speed, 25);
  assert.equal(r.cadence, 88);
  assert.equal(r.power, 210);
  assert.equal(r.hr, 141);
});

test('parseIndoorBikeData: truncated packet keeps what it has and never throws', () => {
  const r = C.parseIndoorBikeData(dv([0x44, 0x00, ...le16(3000), ...le16(180), 0xfa])); // power cut in half
  assert.equal(r.speed, 30);
  assert.equal(r.cadence, 90);
  assert.equal(r.power, undefined);
  const empty = C.parseIndoorBikeData(dv([0x44]));
  assert.equal(empty.speed, undefined);
  assert.equal(C.parseIndoorBikeData(dv([])).power, undefined);
});

test('parseIndoorBikeData: bit 0 set means speed is absent; power is signed', () => {
  const r = C.parseIndoorBikeData(dv([0x41, 0x00, 0xff, 0xff]));
  assert.equal(r.speed, undefined);
  assert.equal(r.power, -1);
});

test('parseIndoorBikeData: every optional field lands at the right offset', () => {
  const bytes = [
    ...le16(0x1ffe),               // flags: speed (bit0 clear) + bits 1..12
    ...le16(3210),                 // speed 32.10
    ...le16(3100),                 // avgSpeed 31.00
    ...le16(181),                  // cadence 90.5
    ...le16(175),                  // avgCadence 87.5
    0x39, 0x30, 0x01,              // distance u24 = 0x013039 = 77881 m
    ...le16(12),                   // resistance
    ...le16(305),                  // power
    ...le16(299),                  // avgPower
    ...le16(500), ...le16(900), 15,// energy total / perHour / perMin
    152,                           // hr
    55,                            // met 5.5
    ...le16(1234),                 // elapsed
    ...le16(2345)                  // remaining
  ];
  const r = C.parseIndoorBikeData(dv(bytes));
  assert.equal(r.speed, 32.1);
  assert.equal(r.avgSpeed, 31);
  assert.equal(r.cadence, 90.5);
  assert.equal(r.avgCadence, 87.5);
  assert.equal(r.distance, 77881);
  assert.equal(r.resistance, 12);
  assert.equal(r.power, 305);
  assert.equal(r.avgPower, 299);
  assert.deepEqual(r.energy, { total: 500, perHour: 900, perMin: 15 });
  assert.equal(r.hr, 152);
  assert.equal(r.met, 5.5);
  assert.equal(r.elapsed, 1234);
  assert.equal(r.remaining, 2345);
});

test('parseIndoorBikeData accepts typed arrays too (e.g. Node Buffers)', () => {
  const r = C.parseIndoorBikeData(Buffer.from([0x44, 0x00, ...le16(3000), ...le16(180), ...le16(250)]));
  assert.equal(r.power, 250);
});

// ---------------------------------------------------------------------------
test('parseHeartRate: u8 and u16 formats', () => {
  assert.equal(C.parseHeartRate(dv([0x00, 142])), 142);
  assert.equal(C.parseHeartRate(dv([0x01, ...le16(300)])), 300);
  assert.equal(C.parseHeartRate(dv([0x16, 77, 0x10, 0x00])), 77);   // extra fields ignored
  assert.equal(C.parseHeartRate(dv([0x01, 0x10])), null);           // u16 flag but only 1 byte
  assert.equal(C.parseHeartRate(dv([])), null);
});

test('parseCyclingPower: instantaneous power at byte 2', () => {
  assert.deepEqual(C.parseCyclingPower(dv([0x00, 0x00, ...le16(222)])), { power: 222 });
  assert.equal(C.parseCyclingPower(dv([0x00, 0x00])).power, undefined);
});

test('parseControlPointResponse', () => {
  const ok = C.parseControlPointResponse(dv([0x80, 0x00, 0x01]));
  assert.deepEqual(ok, { opcode: 0x80, requestOpcode: 0x00, result: 0x01, ok: true });
  const denied = C.parseControlPointResponse(dv([0x80, 0x00, 0x05]));
  assert.equal(denied.ok, false);
  assert.equal(denied.result, C.CP_RESULT.NOT_PERMITTED);
  const bad = C.parseControlPointResponse(dv([0x80, 0x05, 0x03]));
  assert.equal(bad.requestOpcode, 0x05);
  assert.equal(bad.result, 0x03);
  assert.equal(bad.ok, false);
  assert.equal(C.parseControlPointResponse(dv([0x80])).ok, false);
});

// ---------------------------------------------------------------------------
test('encoders', () => {
  assert.ok(C.encRequestControl() instanceof Uint8Array);
  assert.deepEqual(arr(C.encRequestControl()), [0x00]);
  assert.deepEqual(arr(C.encReset()), [0x01]);
  assert.deepEqual(arr(C.encStart()), [0x07]);
  assert.deepEqual(arr(C.encStop()), [0x08, 0x01]);
});

test('encSetTargetPower', () => {
  assert.deepEqual(arr(C.encSetTargetPower(250)), [0x05, 0xfa, 0x00]);
  assert.deepEqual(arr(C.encSetTargetPower(300)), [0x05, 0x2c, 0x01]);
  assert.deepEqual(arr(C.encSetTargetPower(249.6)), [0x05, 0xfa, 0x00]);   // rounded
  assert.deepEqual(arr(C.encSetTargetPower(-30)), [0x05, 0x00, 0x00]);     // clamped low
  assert.deepEqual(arr(C.encSetTargetPower(5000)), [0x05, 0xd0, 0x07]);    // clamped to 2000 = 0x07d0
  assert.deepEqual(arr(C.encSetTargetPower(NaN)), [0x05, 0x00, 0x00]);
});

test('encSetSim', () => {
  assert.deepEqual(arr(C.encSetSim({ grade: 1.5 })), [0x11, 0, 0, 0x96, 0x00, 40, 51]);
  assert.deepEqual(arr(C.encSetSim()), [0x11, 0, 0, 0, 0, 40, 51]);
  assert.deepEqual(arr(C.encSetSim({ grade: -0.5 })), [0x11, 0, 0, 0xce, 0xff, 40, 51]);   // -50 as s16
  assert.deepEqual(arr(C.encSetSim({ grade: 99 })), [0x11, 0, 0, 0xd0, 0x07, 40, 51]);     // clamped to 20 % = 2000
  assert.deepEqual(arr(C.encSetSim({ grade: -99 })), [0x11, 0, 0, 0x18, 0xfc, 40, 51]);    // clamped to -10 % = -1000
  assert.deepEqual(arr(C.encSetSim({ windMs: 2, crr: 0.005, cw: 0.4 })), [0x11, 0xd0, 0x07, 0, 0, 50, 40]);
});

// ---------------------------------------------------------------------------
test('zoneOf boundaries', () => {
  const z = p => C.zoneOf(p).z;
  assert.equal(z(0), 1); assert.equal(z(0.549), 1); assert.equal(z(0.55), 2);
  assert.equal(z(0.755), 2); assert.equal(z(0.76), 3); assert.equal(z(0.909), 3);
  assert.equal(z(0.91), 4); assert.equal(z(1.059), 4); assert.equal(z(1.06), 5);
  assert.equal(z(1.209), 5); assert.equal(z(1.21), 6); assert.equal(z(2), 6);
  assert.deepEqual(Object.keys(C.zoneOf(0.9)).sort(), ['color', 'name', 'z']);
  assert.equal(C.zoneOf(0.5).color, '#7f8c99');
  assert.equal(C.zoneOf(0.7).color, '#3b8bd4');
  assert.equal(C.zoneOf(0.85).color, '#36b37e');
  assert.equal(C.zoneOf(1.0).color, '#e8c23a');
  assert.equal(C.zoneOf(1.15).color, '#f28c28');
  assert.equal(C.zoneOf(1.5).color, '#e5484d');
});

// ---------------------------------------------------------------------------
test('every workout flattens, with positive durations and contiguous segments', () => {
  assert.ok(WORKOUTS.length >= 30);
  for (const w of WORKOUTS) {
    const f = C.flattenWorkout(w, 250);
    assert.ok(f.segments.length > 0, w.id);
    let t = 0;
    for (const s of f.segments) {
      assert.ok(s.dur > 0, w.id + ' dur');
      assert.equal(s.start, t, w.id + ' contiguous');
      assert.ok(['erg', 'ramp', 'free', 'ramptest'].includes(s.kind), w.id + ' kind');
      if (s.kind === 'erg') assert.equal(s.from, s.to);
      if (s.kind === 'free') assert.equal(typeof s.grade, 'number');
      assert.ok(s.zone && s.zone.z >= 1 && s.zone.z <= 6, w.id + ' zone');
      assert.equal(typeof s.label, 'string');
      t += s.dur;
    }
    assert.equal(f.duration, t, w.id + ' total');
    assert.ok(Number.isFinite(f.ifEstimate) && f.ifEstimate > 0 && f.ifEstimate < 1.6, w.id + ' IF');
    assert.ok(Number.isFinite(f.tssEstimate) && f.tssEstimate > 0, w.id + ' TSS');
  }
  for (const [id] of WORKOUT_CATEGORIES) assert.ok(WORKOUTS.some(w => w.cat === id), 'category ' + id + ' has workouts');
});

test('workout durations: ss3x12, ou3x9, vo2_3030', () => {
  assert.equal(C.flattenWorkout(byId('ss3x12'), 250).duration, 600 + 3 * (720 + 300) + 300);   // 3960
  assert.equal(C.flattenWorkout(byId('ss3x12'), 250).duration, 3960);
  assert.equal(C.flattenWorkout(byId('ou3x9'), 250).duration, 600 + 3 * (3 * 180 + 300) + 300); // 3420
  assert.equal(C.flattenWorkout(byId('ou3x9'), 250).duration, 3420);
  assert.equal(C.flattenWorkout(byId('vo2_3030'), 250).duration, 600 + 3 * (600 + 300) + 300); // 3600
  assert.equal(C.flattenWorkout(byId('vo2_3030'), 250).duration, 3600);
});

test('flatten: ss3x12 is 1 + 6 + 1 segments; nested repeats expand; cues carried', () => {
  const f = C.flattenWorkout(byId('ss3x12'), 250);
  assert.equal(f.segments.length, 8);
  assert.deepEqual(f.segments.map(s => s.kind), ['ramp', 'erg', 'erg', 'erg', 'erg', 'erg', 'erg', 'ramp']);
  assert.deepEqual(f.segments.map(s => s.start), [0, 600, 1320, 1620, 2340, 2640, 3360, 3660]);
  assert.deepEqual(f.segments.map(s => s.label), ['Warm-up', 'Work', 'Easy', 'Work', 'Easy', 'Work', 'Easy', 'Cool-down']);
  assert.equal(f.kind, 'workout');
  assert.ok(Math.abs(f.ifEstimate - 0.797) < 0.002);
  assert.ok(Math.abs(f.tssEstimate - 69.9) < 0.3);

  const ou = C.flattenWorkout(byId('ou3x9'), 250);
  assert.equal(ou.segments.length, 1 + 3 * (3 * 2 + 1) + 1);
  const cues = ou.segments.map(s => s.cue).filter(Boolean);
  assert.equal(cues.length, 18);
  assert.deepEqual(cues.slice(0, 4), ['under', 'over', 'under', 'over']);
  assert.equal(C.flattenWorkout(byId('vo2_3030'), 250).segments.length, 1 + 3 * (20 + 1) + 1);
  assert.equal(C.flattenWorkout(byId('tri703'), 250).segments[1].cue, 'race pace, get aero');
});

test('flatten: ramp test, free segments, kinds, IF/TSS of a flat workout', () => {
  const r = C.flattenWorkout(byId('ramp'), null);
  assert.equal(r.kind, 'ramp');
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].kind, 'ramptest');
  assert.equal(r.duration, 1500);

  const t20 = C.flattenWorkout(byId('ftp20'), 250);
  assert.equal(t20.kind, '20min');
  const free = t20.segments.filter(s => s.kind === 'free');
  assert.deepEqual(free.map(s => s.dur), [300, 1200]);
  assert.equal(free[0].grade, 2);
  assert.equal(free[1].cue, 'twenty minutes, all you have, steady');
  assert.equal(C.twentyMinuteEffort(t20.segments), free[1]);

  const fr = C.flattenWorkout(byId('free'), 250);
  assert.equal(fr.kind, 'free');
  assert.equal(fr.segments[0].grade, 1);

  // a flat 1-hour workout at 100 % FTP: IF 1.0, TSS 100
  const flat = C.flattenWorkout({ id: 'x', steps: [[3600, 1.0]] }, 250);
  assert.equal(flat.ifEstimate, 1);
  assert.equal(flat.tssEstimate, 100);
  // free segments count at 0.75
  const f75 = C.flattenWorkout({ id: 'y', steps: [{ free: 3600, grade: 0 }] }, 250);
  assert.ok(Math.abs(f75.ifEstimate - 0.75) < 1e-9);
});

test('flatten rejects bad input', () => {
  assert.throws(() => C.flattenWorkout({ id: 'a', steps: [[0, 0.5]] }, 250));
  assert.throws(() => C.flattenWorkout({ id: 'a', steps: [['x', 0.5]] }, 250));
  assert.throws(() => C.flattenWorkout({ id: 'a', steps: [{ nope: 1 }] }, 250));
  assert.throws(() => C.flattenWorkout({ id: 'a', steps: [] }, 250));
  assert.throws(() => C.flattenWorkout({ id: 'a' }, 250));
});

// ---------------------------------------------------------------------------
test('targetAt: steady, ramp midpoint, scale, free, ramp test, past the end', () => {
  const f = C.flattenWorkout(byId('ss3x12'), 250);
  const at = (t, ftp = 250, scale) => C.targetAt(f.segments, t, ftp, scale);
  assert.equal(at(0), 125);                  // warm-up starts at 50 %
  assert.equal(at(300), 150);                // midpoint of the 50 -> 70 % ramp = 60 %
  assert.equal(at(599), 175);                // end of the ramp, just under 70 %
  assert.equal(at(600), 225);                // first work block at 90 %
  assert.equal(at(1319), 225);
  assert.equal(at(1320), 138);               // 0.55 * 250 = 137.5 rounds up
  assert.equal(at(600, 250, 0.95), 214);     // 225 * 0.95 = 213.75
  assert.equal(at(600, 300), 270);
  assert.equal(at(3960), null);              // after the end
  assert.equal(at(600, null), null);         // no FTP, no watts

  const t20 = C.flattenWorkout(byId('ftp20'), 250);
  const freeSeg = t20.segments.find(s => s.kind === 'free');
  assert.equal(C.targetAt(t20.segments, freeSeg.start + 10, 250, 1), null);

  const rt = C.flattenWorkout(byId('ramp'), null).segments;
  assert.equal(C.targetAt(rt, 0, null), 100);
  assert.equal(C.targetAt(rt, 59, null), 100);
  assert.equal(C.targetAt(rt, 60, null, 0.5), 120);   // scale is ignored in the ramp test
});

test('targetAt on an explicit mid-ramp', () => {
  const segs = C.flattenWorkout({ id: 'r', steps: [[100, 0.5, 1.0]] }, 200).segments;
  assert.equal(C.targetAt(segs, 50, 200), 150);   // 0.75 * 200
  assert.equal(C.targetAt(segs, 25, 200), 125);   // 0.625 * 200
});

// ---------------------------------------------------------------------------
test('computeMetrics: constant ride', () => {
  const samples = Array.from({ length: 600 }, (_, i) => ({ t: i, target: 200, power: 200, cadence: 90, hr: 140 }));
  const m = C.computeMetrics(samples, 250);
  assert.equal(m.avgPower, 200);
  assert.equal(m.maxPower, 200);
  assert.equal(m.np, 200);
  assert.equal(m.avgCadence, 90);
  assert.equal(m.avgHr, 140);
  assert.equal(m.maxHr, 140);
  assert.equal(m.duration, 600);
  assert.equal(m.kj, 120);
  assert.ok(Math.abs(m.if - 0.8) < 1e-12);
  assert.equal(m.best.p60, 200);
  assert.equal(m.best.p300, 200);
  assert.equal(m.best.p1200, null);          // ride is shorter than 20 minutes
  assert.equal(m.eftp, null);
});

test('computeMetrics: 1 hour at FTP is TSS 100, IF 1.0', () => {
  const samples = Array.from({ length: 3600 }, (_, i) => ({ t: i, power: 250, cadence: 90, hr: null }));
  const m = C.computeMetrics(samples, 250);
  assert.equal(m.np, 250);
  assert.equal(m.if, 1);
  assert.ok(Math.abs(m.tss - 100) < 1e-9);
  assert.equal(m.avgHr, null);
  assert.equal(m.maxHr, null);
  assert.equal(m.best.p1200, 250);
  assert.equal(m.eftp, Math.round(0.95 * 250));   // 238
});

test('computeMetrics: no FTP, nulls, short rides, ramp-test eFTP', () => {
  const m0 = C.computeMetrics([], 250);
  assert.equal(m0.duration, 0);
  assert.equal(m0.avgPower, 0);
  assert.equal(m0.avgHr, null);

  const short = Array.from({ length: 20 }, () => ({ power: 100, cadence: 80, hr: 120 }));
  const ms = C.computeMetrics(short, null);
  assert.equal(ms.np, 100);          // < 30 samples: NP falls back to the average
  assert.equal(ms.if, null);
  assert.equal(ms.tss, null);
  assert.equal(ms.best.p60, null);

  // null power counts as 0 W in averages; null cadence / HR are skipped
  const gaps = [{ power: 200, cadence: 90, hr: 100 }, { power: null, cadence: null, hr: null }];
  const mg = C.computeMetrics(gaps, 200);
  assert.equal(mg.avgPower, 100);
  assert.equal(mg.avgCadence, 90);
  assert.equal(mg.avgHr, 100);
  assert.equal(mg.kj, 0.2);

  // ramp test: eFTP = 75 % of the best minute, whatever the ride length
  const ramp = [];
  for (let k = 0; k < 10; k++) for (let i = 0; i < 60; i++) ramp.push({ t: k * 60 + i, power: 100 + 20 * k, cadence: 90 });
  const mr = C.computeMetrics(ramp, 250, { isRampTest: true });
  assert.equal(mr.best.p60, 280);
  assert.equal(mr.eftp, 210);
});

test('computeMetrics: NP rises above average on a variable ride', () => {
  const samples = [];
  for (let i = 0; i < 1200; i++) samples.push({ t: i, power: Math.floor(i / 60) % 2 ? 300 : 100 });
  const m = C.computeMetrics(samples, 250);
  assert.equal(m.avgPower, 200);
  assert.ok(m.np > 200 && m.np < 300);
  assert.equal(m.best.p60, 300);
  assert.equal(m.best.p1200, 200);
});

// ---------------------------------------------------------------------------
test('rampTestTargetAt: 100 W + 20 W each minute, capped at 40 steps', () => {
  assert.equal(C.rampTestTargetAt(0), 100);
  assert.equal(C.rampTestTargetAt(59.9), 100);
  assert.equal(C.rampTestTargetAt(60), 120);
  assert.equal(C.rampTestTargetAt(840), 380);
  assert.equal(C.rampTestTargetAt(39 * 60), 880);
  assert.equal(C.rampTestTargetAt(9999), 880);
  assert.equal(C.rampTestTargetAt(-5), 100);
});

test('rampFailureDetector: low cadence for 6 samples in a row', () => {
  const d = C.rampFailureDetector();
  for (let t = 100; t < 105; t++) assert.equal(d.feed({ t, target: 200, power: 200, cadence: 45 }), false);
  assert.equal(d.feed({ t: 105, target: 200, power: 200, cadence: 45 }), true);   // 6th in a row
  assert.equal(d.failed, true);
  assert.equal(d.feed({ t: 106, target: 200, power: 200, cadence: 90 }), true);   // stays failed

  const d2 = C.rampFailureDetector();            // the counter resets when cadence recovers (armed by the 90 rpm sample)
  assert.equal(d2.feed({ t: 0, target: 100, power: 100, cadence: 90 }), false);
  for (let t = 1; t < 6; t++) assert.equal(d2.feed({ t, target: 100, power: 100, cadence: 40 }), false);
  assert.equal(d2.feed({ t: 6, target: 100, power: 100, cadence: 90 }), false);
  for (let t = 7; t < 12; t++) assert.equal(d2.feed({ t, target: 100, power: 100, cadence: 40 }), false);
  assert.equal(d2.failed, false);

  const d3 = C.rampFailureDetector();            // missing cadence is not "low cadence"
  for (let t = 0; t < 30; t++) assert.equal(d3.feed({ t, target: 100, power: 100, cadence: null }), false);

  const d4 = C.rampFailureDetector();            // clipping in slowly: low cadence before the rider gets going is ignored
  for (let t = 0; t < 20; t++) assert.equal(d4.feed({ t, target: 100, power: 30, cadence: 20 }), false);
  assert.equal(d4.feed({ t: 20, target: 100, power: 100, cadence: 85 }), false);   // now armed
  for (let t = 21; t < 26; t++) assert.equal(d4.feed({ t, target: 100, power: 100, cadence: 40 }), false);
  assert.equal(d4.feed({ t: 26, target: 100, power: 100, cadence: 40 }), true);    // 6th low sample after arming

  const d5 = C.rampFailureDetector();            // never pedaled properly: arms by itself at 60 s
  for (let t = 0; t < 65; t++) assert.equal(d5.feed({ t, target: 100, power: 30, cadence: 20 }), false);
  assert.equal(d5.feed({ t: 65, target: 100, power: 30, cadence: 20 }), true);     // samples 60..65 = 6 in a row
});

test('rampFailureDetector: power under 85 % of target for 15 samples, only after 3 minutes', () => {
  const d = C.rampFailureDetector();
  for (let t = 100; t < 160; t++) assert.equal(d.feed({ t, target: 300, power: 150, cadence: 90 }), false); // too early
  const d2 = C.rampFailureDetector();
  for (let t = 180; t < 194; t++) assert.equal(d2.feed({ t, target: 300, power: 250, cadence: 90 }), false); // 14 samples
  assert.equal(d2.feed({ t: 194, target: 300, power: 250, cadence: 90 }), true);                              // 15th
  const d3 = C.rampFailureDetector();            // 254 W is above 85 % of 300 W
  for (let t = 180; t < 400; t++) assert.equal(d3.feed({ t, target: 300, power: 256, cadence: 90 }), false);
  const d4 = C.rampFailureDetector();            // a good sample in the middle resets the count
  for (let t = 180; t < 190; t++) d4.feed({ t, target: 300, power: 200, cadence: 90 });
  d4.feed({ t: 190, target: 300, power: 300, cadence: 90 });
  for (let t = 191; t < 205; t++) assert.equal(d4.feed({ t, target: 300, power: 200, cadence: 90 }), false);
});

test('rampFailureDetector: cadence 0 or no power for 6 samples, only after 1 minute', () => {
  const d = C.rampFailureDetector();
  for (let t = 10; t < 50; t++) assert.equal(d.feed({ t, target: 100, power: null, cadence: 90 }), false); // too early
  const d2 = C.rampFailureDetector();
  for (let t = 60; t < 65; t++) assert.equal(d2.feed({ t, target: 100, power: null, cadence: 90 }), false);
  assert.equal(d2.feed({ t: 65, target: 100, power: null, cadence: 90 }), true);
  const d3 = C.rampFailureDetector();
  for (let t = 100; t < 106; t++) d3.feed({ t, target: 100, power: 100, cadence: 0 });   // 6 samples
  assert.equal(d3.failed, true);                 // (the cadence < 50 rule also fires here)
  d3.reset();
  assert.equal(d3.failed, false);
});

test('rampResult on a synthetic ramp: FTP = 75 % of the best minute', () => {
  const samples = [];
  for (let k = 0; k < 14; k++) for (let i = 0; i < 60; i++) {
    const t = k * 60 + i;
    samples.push({ t, target: C.rampTestTargetAt(t), power: C.rampTestTargetAt(t), cadence: 90, hr: 120 + k });
  }
  const r = C.rampResult(samples);
  assert.equal(r.bestMinute, 360);               // last full minute: 100 + 20 * 13
  assert.equal(r.ftp, 270);
  const r2 = C.rampResult(samples.slice(0, 59));
  assert.equal(r2.ftp, null);                    // under a minute of data
  assert.equal(C.rampResult(samples).ftp, C.computeMetrics(samples, 250, { isRampTest: true }).eftp);
});

// ---------------------------------------------------------------------------
test('toTCX: well-formed XML, one Trackpoint per sample, Watts present', () => {
  const samples = [
    { t: 0, power: 120, cadence: 88, hr: 140 },
    { t: 1, power: 125.4, cadence: null, hr: 141 },
    { t: 2, power: 130, cadence: 90, hr: null },
    { t: 3, power: null, cadence: null, hr: null }
  ];
  const xml = C.toTCX({ startedAt: Date.parse('2026-10-29T13:00:00Z'), name: 'Sweet Spot 3x12 & <more>', samples });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Id>2026-10-29T13:00:00Z<\/Id>/);
  assert.match(xml, /<Lap StartTime="2026-10-29T13:00:00Z">/);
  assert.match(xml, /<TotalTimeSeconds>4<\/TotalTimeSeconds>/);
  assert.match(xml, /<Activity Sport="Biking">/);
  assert.match(xml, /<Notes>ERG: Sweet Spot 3x12 &amp; &lt;more&gt;<\/Notes>/);

  const points = xml.match(/<Trackpoint>[\s\S]*?<\/Trackpoint>/g);
  assert.equal(points.length, samples.length);
  assert.match(points[0], /<Time>2026-10-29T13:00:00Z<\/Time>/);
  assert.match(points[0], /<HeartRateBpm><Value>140<\/Value><\/HeartRateBpm>/);
  assert.match(points[0], /<Cadence>88<\/Cadence>/);
  assert.match(points[0], /<ns3:Watts>120<\/ns3:Watts>/);
  assert.match(points[1], /<Time>2026-10-29T13:00:01Z<\/Time>/);
  assert.doesNotMatch(points[1], /<Cadence>/);                    // null cadence omitted
  assert.match(points[1], /<ns3:Watts>125<\/ns3:Watts>/);
  assert.doesNotMatch(points[2], /HeartRateBpm/);                 // null HR omitted
  assert.doesNotMatch(points[3], /HeartRateBpm|<Cadence>/);
  assert.match(points[3], /<ns3:Watts>0<\/ns3:Watts>/);
  assert.equal((xml.match(/<ns3:Watts>/g) || []).length, samples.length);

  // minimal well-formedness check: every tag closes in order
  const stack = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/, '').matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2]); else stack.push(m[2]);
  }
  assert.equal(stack.length, 0);
});

test('toTCX: accepts ISO start, workout.name, and an empty ride', () => {
  const xml = C.toTCX({ startedAt: '2026-10-29T13:00:00Z', workout: { name: 'Ramp Test' }, samples: [] });
  assert.match(xml, /<Notes>ERG: Ramp Test<\/Notes>/);
  assert.equal((xml.match(/<Trackpoint>/g) || []).length, 0);
  assert.match(xml, /<TotalTimeSeconds>0<\/TotalTimeSeconds>/);
});

test('tcxFilename and slug', () => {
  const ms = new Date(2026, 9, 29, 8, 0, 0).getTime();   // local time, so the local date is Oct 29
  assert.equal(C.tcxFilename({ startedAt: ms, name: 'Sweet Spot 3x12' }), 'erg-2026-10-29-sweet-spot-3x12.tcx');
  assert.equal(C.slug('30/30s'), '30-30s');
  assert.equal(C.slug('  !!! '), 'ride');
});

// ---------------------------------------------------------------------------
test('format helpers', () => {
  assert.equal(C.fmtClock(65), '1:05');
  assert.equal(C.fmtClock(720), '12:00');
  assert.equal(C.fmtClock(3600), '1:00:00');
  assert.equal(C.fmtClock(-4), '0:00');
  assert.equal(C.fmtHM(3900), '1:05');
  assert.equal(C.fmtHM(1800), '0:30');
  assert.equal(C.fmtHM(3960), '1:06');
});

test('describeWorkout: plain-words step list', () => {
  const lines = C.describeWorkout(byId('ss3x12'), 250);
  assert.deepEqual(lines, ['10:00 warm-up, 125–175 W', '3 × 12:00 @ 225 W, 5:00 easy between', '5:00 cool-down, 138–113 W']);
  const noFtp = C.describeWorkout(byId('ss3x12'), null);
  assert.equal(noFtp[1], '3 × 12:00 @ 90%, 5:00 easy between');
  const ou = C.describeWorkout(byId('ou3x9'), 250);
  assert.ok(ou.some(l => /3 sets, 5:00 easy between sets/.test(l)));
  assert.ok(ou.some(l => /Each set: 3 × \(2:00 @ 238 W, 1:00 @ 263 W\)/.test(l)));
  for (const w of WORKOUTS) {
    const l = C.describeWorkout(w, 250);
    assert.ok(l.length > 0 && l.every(x => typeof x === 'string' && x.length > 0), w.id);
  }
});

test('suggestWorkoutId', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const day = 86400000;
  const base = { ftp: 250, lastTestAt: now - 10 * day, lastCat: null, rideCount: 0, now };
  assert.equal(C.suggestWorkoutId({ ...base, ftp: null }), 'ramp');
  assert.equal(C.suggestWorkoutId({ ...base, lastTestAt: now - 57 * day }), 'ramp');
  assert.equal(C.suggestWorkoutId({ ...base, lastTestAt: null }), 'ramp');
  assert.equal(C.suggestWorkoutId({ ...base, lastTestAt: now - 56 * day }), 'end60');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'recovery' }), 'ss3x12');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'sweetspot' }), 'end60');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'endurance', rideCount: 4 }), 'thr3x10');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'endurance', rideCount: 5 }), 'vo2_4x4');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'threshold', rideCount: 2 }), 'rec30');
  assert.equal(C.suggestWorkoutId({ ...base, lastCat: 'vo2', rideCount: 3 }), 'end60');
  for (const id of ['rec30', 'ss3x12', 'end60', 'thr3x10', 'vo2_4x4']) assert.ok(byId(id), id + ' exists');
});

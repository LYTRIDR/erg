# ERG — build spec (v1)

A free, single-purpose indoor trainer app. Connects to a Wahoo KICKR CORE (any FTMS trainer) over Web Bluetooth, runs pre-built ERG workouts, estimates FTP from a ramp test, scales everything off it. Runs on an iPad inside the Bluefy browser, and in Chrome/Edge on desktop or Android.

Owner: Eric (LYTRIDR). Rider profile: endurance athlete, half-Ironman / sprint-tri. Watches TV while riding, rarely looks at the screen. Wants: pick a workout, pedal, be told what to do by voice, get a number at the end.

## Hard rules

1. **No text inputs anywhere.** Every setting is a button, stepper (−/+), toggle or chip. `<input type="text|number">` and `<textarea>` are forbidden.
2. **No build step, no dependencies, no CDN, no fonts.** Plain HTML/CSS/JS, served as static files from GitHub Pages. No frameworks. No service worker.
3. **Files:** `index.html` (markup, styles, app logic inline), `core.js` (pure logic, no DOM), `workouts.js` (provided; do not change the data, only read it), `test/core.test.js` (node:test), `test/e2e.mjs` (Playwright, headless, sim trainer), `README.md`.
4. **Everything local.** Settings in `localStorage`, rides in IndexedDB (fallback to localStorage if IDB throws). No network calls at all after page load.
5. **Bluetooth UUIDs as full 128-bit lowercase strings** everywhere (`'00001826-0000-1000-8000-00805f9b34fb'`), never numbers or `BluetoothUUID.*`. Bluefy's polyfill is the reason.
6. **One GATT operation at a time.** All control-point writes go through a promise queue. Overlapping writes throw "GATT operation already in progress" and break the ride.
7. Prefer `writeValueWithResponse` when the characteristic has it, else `writeValue`. Wrap every BLE call in try/catch; never let a BLE error kill the workout clock.
8. Dark UI, numbers readable from 8 feet, works landscape and portrait on an iPad (1180×820 logical landscape; also 768×1024). Phone width should not break but is not the target.
9. Any test mode / debug hook must be invisible unless enabled by a URL flag.

## core.js — pure functions (exported on `globalThis.ERGCore`, and `module.exports` for Node)

### Bluetooth parsing / encoding

```
UUIDS = {
  FTMS:        '00001826-0000-1000-8000-00805f9b34fb',
  INDOOR_BIKE: '00002ad2-0000-1000-8000-00805f9b34fb',   // notify
  CONTROL_PT:  '00002ad9-0000-1000-8000-00805f9b34fb',   // write + indicate
  FTMS_STATUS: '00002ada-0000-1000-8000-00805f9b34fb',   // notify (optional)
  FTMS_FEATURE:'00002acc-0000-1000-8000-00805f9b34fb',   // read (optional)
  POWER_RANGE: '00002ad8-0000-1000-8000-00805f9b34fb',   // read (optional)
  HRS:         '0000180d-0000-1000-8000-00805f9b34fb',
  HR_MEAS:     '00002a37-0000-1000-8000-00805f9b34fb',
  CPS:         '00001818-0000-1000-8000-00805f9b34fb',   // optional fallback
  CP_MEAS:     '00002a63-0000-1000-8000-00805f9b34fb',
  BATTERY:     '0000180f-0000-1000-8000-00805f9b34fb',
  DEV_INFO:    '0000180a-0000-1000-8000-00805f9b34fb'
}
```

`parseIndoorBikeData(dataView) -> {speed, avgSpeed, cadence, avgCadence, distance, resistance, power, avgPower, energy, hr, met, elapsed, remaining}` (absent fields `undefined`). FTMS Indoor Bike Data, all little-endian:

```
flags = u16 @0 ; o = 2
if (!(flags & 0x0001)) speed      = u16/100 km/h   ; o+=2   // bit0 "More Data" == 0 means speed IS present
if   (flags & 0x0002)  avgSpeed   = u16/100        ; o+=2
if   (flags & 0x0004)  cadence    = u16/2 rpm      ; o+=2
if   (flags & 0x0008)  avgCadence = u16/2          ; o+=2
if   (flags & 0x0010)  distance   = u24 m          ; o+=3
if   (flags & 0x0020)  resistance = s16            ; o+=2
if   (flags & 0x0040)  power      = s16 W          ; o+=2
if   (flags & 0x0080)  avgPower   = s16            ; o+=2
if   (flags & 0x0100)  energy = {total:u16, perHour:u16, perMin:u8} ; o+=5
if   (flags & 0x0200)  hr         = u8             ; o+=1
if   (flags & 0x0400)  met        = u8/10          ; o+=1
if   (flags & 0x0800)  elapsed    = u16 s          ; o+=2
if   (flags & 0x1000)  remaining  = u16 s          ; o+=2
```
Before every read check `o + size <= byteLength`; stop parsing (keep what you have) if the packet is short.

`parseHeartRate(dataView) -> bpm`: flags u8 @0; if `flags & 1` HR is u16 LE @1 else u8 @1.

`parseCyclingPower(dataView) -> {power}`: flags u16 @0, instantaneous power s16 LE @2. (Fallback only.)

`parseControlPointResponse(dataView) -> {opcode, requestOpcode, result, ok}`: bytes `[0x80, requestOp, result]`; `ok = result === 0x01`. Result codes: 0x01 success, 0x02 not supported, 0x03 invalid parameter, 0x04 operation failed, 0x05 control not permitted.

Encoders (return `Uint8Array`):
- `encRequestControl()` → `[0x00]`
- `encReset()` → `[0x01]`
- `encStart()` → `[0x07]`
- `encStop()` → `[0x08, 0x01]`
- `encSetTargetPower(watts)` → `[0x05, lo, hi]` int16 LE, watts clamped to 0..2000 and rounded.
- `encSetSim({grade=0, windMs=0, crr=0.004, cw=0.51})` → `[0x11, wind s16 LE in 0.001 m/s, grade s16 LE in 0.01 %, crr u8 in 0.0001, cw u8 in 0.01 kg/m]`. For grade 1.5 the grade bytes are `150 → 0x96 0x00`. Clamp grade to −10..20.

### Workout flattening

`flattenWorkout(workout, ftp) -> {segments, duration, ifEstimate, tssEstimate, kind}` where each segment is
`{start, dur, kind:'erg'|'ramp'|'free'|'ramptest', from, to, cue, zone, label}` (`from/to` fractions of FTP; for `erg` from===to; `free` has `grade`). Repeats expand. Nested repeats work (see `ou3x9`, `vo2_3030`). The 4th array element is the cue. `duration` is the sum. For `ramptest` the flattened duration is a placeholder 1500 s (the engine ends it dynamically). `ifEstimate`/`tssEstimate` from the planned profile (ramps integrate linearly; free segments count at 0.75). Assert every workout in `WORKOUTS` flattens without throwing and every segment has `dur > 0`.

`targetAt(segments, t, ftp, scale)`: watts at elapsed second `t` (ramps interpolate linearly, rounded to 1 W), multiplied by `scale` (intensity, 1.0 default). Returns `null` during `free` segments.

`zoneOf(pct)`: Coggan zones by fraction of FTP — Z1 <0.55, Z2 <0.76, Z3 <0.91, Z4 <1.06, Z5 <1.21, Z6 ≥1.21. Returns `{z:1..6, name, color}`.

### Metrics (`computeMetrics(samples, ftp, {isRampTest})`)

Samples are 1 Hz: `{t, target, power, cadence, hr}` (power/cadence/hr may be `null` when no data arrived in the last 3 s; treat null power as 0 for averages but skip for cadence/HR averages).

- `avgPower`, `maxPower`, `avgCadence`, `avgHr`, `maxHr`, `duration`, `kj = Σpower/1000`
- `np`: 30-s rolling average of power (simple moving window, only once ≥30 samples exist), raise each to the 4th power, mean, 4th root. If < 30 samples, `np = avgPower`.
- `if = np / ftp`, `tss = duration * np * if / (ftp * 3600) * 100` (null when no FTP)
- `best = {p60, p300, p1200}` best rolling averages (null if ride shorter than the window)
- `eftp`: ramp test → `round(0.75 * best.p60)`; otherwise `round(0.95 * best.p1200)` if `p1200` exists, else `null`.

### Ramp test engine helpers

- `rampTestTargetAt(t)`: step k = floor(t/60), target = 100 + 20k watts (no FTP needed). Max 40 steps.
- `rampFailureDetector()` returns an object with `feed({t, target, power, cadence}) -> boolean` (true = failed) implementing: cadence < 50 rpm for 6 consecutive samples, **or** power < 0.85 × target for 15 consecutive samples **after** t ≥ 180 s, **or** `cadence === 0`/power `null` for 6 consecutive samples after t ≥ 60 s. Reset counters when the condition clears.
- `rampResult(samples) -> {ftp, bestMinute}` with `ftp = round(0.75 * best60s)`.

### TCX export

`toTCX(ride) -> string`. Garmin TCX v2 with power in the `TPX` extension (Strava and Garmin Connect both accept this):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities><Activity Sport="Biking">
    <Id>2026-10-29T13:00:00Z</Id>
    <Lap StartTime="2026-10-29T13:00:00Z">
      <TotalTimeSeconds>3600</TotalTimeSeconds><DistanceMeters>0</DistanceMeters>
      <Calories>0</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
      <Track>
        <Trackpoint><Time>…Z</Time><HeartRateBpm><Value>140</Value></HeartRateBpm><Cadence>88</Cadence>
          <Extensions><ns3:TPX><ns3:Watts>250</ns3:Watts></ns3:TPX></Extensions></Trackpoint>
      </Track>
    </Lap>
    <Notes>ERG: Sweet Spot 3x12</Notes>
  </Activity></Activities>
</TrainingCenterDatabase>
```
Omit `HeartRateBpm`/`Cadence` elements when null. One `Trackpoint` per sample. Escape XML in the notes.

## Trainer drivers (in index.html)

Common interface: `connect() / disconnect() / setTargetPower(w) / setSim({grade}) / start() / on('data', fn) / on('status', fn) / name`.

### BleTrainer
1. `navigator.bluetooth.requestDevice({filters:[{services:[UUIDS.FTMS]}], optionalServices:[UUIDS.HRS, UUIDS.CPS, UUIDS.BATTERY, UUIDS.DEV_INFO]})`
2. `gatt.connect()`, `getPrimaryService(FTMS)`, get `INDOOR_BIKE` and `CONTROL_PT`.
3. `CONTROL_PT.startNotifications()` and listen for responses first; then `INDOOR_BIKE.startNotifications()` → `parseIndoorBikeData` → emit `data`.
4. Queue: `write(encRequestControl())` → wait for the response (timeout 3 s). If result 0x05: emit status `"Another app has control of the trainer. Close the Wahoo app / Zwift, turn the trainer off and on, then reconnect."` If timeout: continue anyway (some firmware doesn't indicate), note it in status.
5. `write(encStart())` (ignore result).
6. `setTargetPower(w)`: `write(encSetTargetPower(w))`. `setSim({grade})`: `write(encSetSim(...))`. Both coalesce: if a write is pending and a newer target arrives, drop the older one (keep latest).
7. Keepalive: the app re-sends the current target every 10 s even if unchanged.
8. `gattserverdisconnected` → status "Trainer disconnected, reconnecting…" → try `gatt.connect()` up to 10 times, 2 s apart; on success redo steps 2–5 and re-send the current target/sim. Give up → status "Trainer lost. Tap Reconnect." with a button. The workout clock does **not** pause on disconnect.
9. If `INDOOR_BIKE` is missing, try `CPS/CP_MEAS` for power only.

### BleHeartRate
`requestDevice({filters:[{services:[UUIDS.HRS]}]})`, `HR_MEAS.startNotifications()`, `parseHeartRate`. Optional. Reconnect same as above.

### SimTrainer (enabled by `?sim=1`)
Emits `data` once per workout-second: power drifts toward target with a 2-s lag plus ±8 W noise; cadence 88 ± 3; HR from an inline model (rises toward 60 + 0.45·power with a 20-s lag). In sim mode (`setSim`): power = 120 + 40·grade ± 10. `?simFail=380` → once target ≥ 380 W, cadence decays 10 rpm/s to 0 and power follows (for ramp-test E2E). `?sim=1` shows a "Demo trainer" button on the connect screen instead of silently connecting.

## App engine (index.html)

### State
`{screen, ftp, ftpSource:{kind:'ramp'|'20min'|'manual'|'auto', date}, settings:{voice:true, beeps:true, autoEase:true, keepAwake:true}, trainer, hrm, ride:{workout, segments, elapsed, segIndex, scale:1.0, grade, paused, samples[], startedAt, rampTest:{failed, ftp}}, live:{power, cadence, hr, lastDataAt}}`

### Clock
`tick()` every 250 ms via `setInterval`; `elapsed += (now - lastTick) * speed / 1000` only when running (not paused). `speed` is 1 unless `?speed=N` (test only; disables audio). Never count intervals; always use `performance.now()` deltas. One sample is recorded each time `floor(elapsed)` advances (and only one per second, even if a tick jumps). The sim trainer emits data on the same schedule so samples line up.

### Segment transitions
When `elapsed ≥ segment.start + segment.dur` advance. On entering a segment:
- ERG/ramp: compute target, send to trainer immediately; voice: `"<duration> at <watts> watts"` plus the cue if any (e.g. "Ten minutes at 230 watts. Race pace, get aero."). Rest segments say "Easy, <duration>".
- Free: `setSim({grade})`; voice says the cue or "Free ride, <duration>".
- During ramp segments re-send the target whenever it changes by ≥1 W (every second).
- Beeps (Web Audio oscillator, 880 Hz, 80 ms) at 3-2-1 s before a transition **into** a harder segment (`to > current`). Nothing before easier ones.
- 10 s before a work segment ends: "Ten seconds."
- Halfway through any segment ≥ 10 min: "Halfway."

Voice = `speechSynthesis` with `SpeechSynthesisUtterance`, `rate 1.0`, cancel any queued utterance before speaking a transition. Numbers spoken as digits ("230 watts") — TTS handles it. On the Start tap, unlock audio: `speechSynthesis.speak(new SpeechSynthesisUtterance(' '))` and `audioCtx.resume()`.

### Intensity and auto-ease
- `−5% / +5%` buttons change `ride.scale` (0.5..1.5), re-send the target, show "92%" badge. Debounce writes 300 ms.
- Auto-ease (setting, default on, never during ramp test): during an ERG segment with `from ≥ 0.85`, if cadence < 55 for 8 consecutive seconds and we have power data, `scale −= 0.05`, speak "Easing 5 percent", 30-s lockout before it can trigger again.
- Skip button: jump to the next segment. End button: confirm (two-tap: "End ride?" → "End") then go to Summary.
- Pause: stop the clock; send `encSetTargetPower(round(0.4*ftp))` or 80 W if unknown, so the pedals go light; resume re-sends the real target. Pause time isn't recorded.

### Ramp test (segment kind `ramptest`)
Target = `rampTestTargetAt(tSinceSegStart)`; voice at each step: "<watts>". Failure via `rampFailureDetector`. Also an "I'm done" button replaces Skip. On failure or I'm done: compute `rampResult`, speak "Done. Your FTP is <ftp>.", then switch into a 5-min cooldown ERG segment at `max(60, round(0.4*ftp))` W (the segments array is rewritten in place: ramptest segment's dur becomes what elapsed, cooldown appended). If the test lasted < 5 min: don't propose an FTP, say "Too short to score".

### FTP right-sizing
- Library header shows `FTP 250 · ramp test, Oct 29` or `FTP not set — do the Ramp Test`.
- Starting a non-test workout with no FTP: a sheet says "Set FTP first" with two buttons: "Ramp Test" and "Set it by hand" (stepper −10/−1/+1/+10 starting at 200, "Use 200").
- On Summary: if `eftp` exists and `eftp ≥ 1.02 × ftp` (or no FTP yet): "Your FTP looks like 265. Update?" [Use 265] [Keep 250]. After a test workout always propose `eftp` (ramp → 0.75·best minute; 20-min test → `0.95 × avg power of the 20-min free segment`, not best-20 of the whole ride). Never auto-lower except from a test; from a test, propose whatever it measured.
- Settings: FTP stepper (−10 −1 +1 +10), voice toggle, beeps toggle, auto-ease toggle, keep-awake toggle, "Clear ride history" (two-tap confirm).

### Screens
1. **Connect** — "Connect Trainer" (big), "Connect Heart Rate" (secondary, optional), status line, trainer name when connected, "Continue" to Library. Show a plain-language note if `navigator.bluetooth` is missing: "This browser can't do Bluetooth. On iPad use the free Bluefy browser; on a computer use Chrome or Edge."
2. **Library** — FTP line at top (tap → Settings). Category chips (from `WORKOUT_CATEGORIES`), "All". Duration chips: ≤30, 45, 60, 75+. Cards: name, duration (`1:05`), IF and TSS at the current FTP (or "—"), description, a small SVG profile (bars colored by zone, height by pct). "Suggested" badge on one card: Ramp Test if no FTP or last test > 56 days; else rotate by last ride's category: recovery→sweetspot, sweetspot→endurance, endurance→threshold or vo2 (alternate), threshold/vo2→recovery or endurance. Links: History, Settings.
3. **Preview** — name, duration, IF/TSS, full description, big profile, step list in plain words ("3 × 12:00 @ 225 W, 5:00 easy between"), intensity −/+ (pre-ride), "Start" (disabled with reason if no trainer connected: "Connect a trainer first" + button to Connect). Also offer "Ride without trainer" (records nothing useful but lets the clock run) only when `?sim=1` is absent and no trainer; keep it small.
4. **Ride** — the display. Landscape layout:
   - Top strip: workout name · elapsed / total · intensity badge.
   - Center: **TARGET** (huge, zone-colored) and **POWER** (huge, 3-s average, white; turns zone color when within ±5% of target). Under them: cadence, heart rate (— if none).
   - Interval: time remaining in this segment (large), "Next: 5:00 easy" / "Next: 12:00 @ 225 W".
   - Profile bar across the bottom with a progress cursor.
   - Buttons: Pause/Resume, Skip (or "I'm done" in ramp test), −5%, +5%, End. In free segments: Grade −0.5 / +0.5 instead of −5/+5, and show the running average power of this segment.
   - Status toast area for BLE messages.
   - Portrait: stack the same, numbers still big.
5. **Summary** — duration, avg power, NP, IF, TSS, kJ, avg/max HR, best 1/5/20-min, eFTP and the update prompt, a power-vs-target chart (inline SVG, simple polyline over the planned profile). Buttons: "Export TCX" (see below), "Done". Save the ride to IndexedDB on entry.
6. **History** — list (date, name, duration, NP, TSS); tap → summary view of that ride (same component) with Export and Delete (two-tap).

Export: build the TCX blob; `if (navigator.canShare && navigator.canShare({files:[file]})) navigator.share({files:[file], title})` → else `<a download>` with an object URL → else open the XML in a new tab (`window.open(url)`). Filename `erg-2026-10-29-sweet-spot-3x12.tcx`.

Keep awake: `navigator.wakeLock.request('screen')` on ride start, re-request on `visibilitychange` back to visible; if unavailable show once, on the Ride screen, "Set Auto-Lock to Never in iPad Settings so the screen stays on" (dismissable, remembered).

### Visual
Dark: background `#0b0d10`, panels `#14181d`, text `#e9edf1`, muted `#8a94a0`. Zone colors: Z1 `#7f8c99`, Z2 `#3b8bd4`, Z3 `#36b37e`, Z4 `#e8c23a`, Z5 `#f28c28`, Z6 `#e5484d`. System font stack, `font-variant-numeric: tabular-nums`. Target/Power numerals ≥ 22vh tall on the ride screen in landscape. Buttons ≥ 64 px tall, high contrast, no hover-only affordances. No animations other than the progress cursor. `user-select: none` on the ride screen. `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `apple-mobile-web-app-capable`.

### Test hooks (only when `?sim=1` or `?speed=`)
`window.__erg = { state, startWorkout(id), getSamples(), finish(), core: ERGCore }`. The E2E script must be able to: load `index.html?sim=1&speed=60&simFail=380`, click Demo trainer, start `ramp`, wait for Summary, read `state.ride.rampTest.ftp` and assert it equals `round(0.75 × best 60-s power)` computed from `getSamples()`, and that the value is in 240..300 (the sim fails at 380 W → best minute ≈ 360–380 → FTP ≈ 270–285). Then start `ss3x12` at speed 60, assert segment count = 1 + 6 + 1 = 8, the targets sent to the sim trainer match `targetAt` for a dozen sampled seconds, and the summary's TSS is within 5% of the planned estimate.

## Tests

- `test/core.test.js` (node:test, `node --test test/`): parse Indoor Bike Data for a packet with flags `0x0044` (speed + cadence + power), `0x0244` (adds HR), a truncated packet; HR u8 and u16; control point responses; `encSetTargetPower(250)` → `[0x05, 0xFA, 0x00]`, `encSetTargetPower(300)` → `[0x05, 0x2C, 0x01]`; `encSetSim({grade:1.5})` → `[0x11,0,0,0x96,0x00,40,51]`; every workout flattens, durations: `ss3x12` = 600+3·(720+300)+300 = 3960; `ou3x9` = 600+3·(3·180+300)+300 = 3420; `vo2_3030` = 600+3·(600+300)+300 = 3600; `targetAt` on a ramp at the midpoint; NP of a constant-power ride equals that power; TSS of 1 h at FTP = 100; `rampResult` on a synthetic ramp; TCX is well-formed (parse it back with a minimal regex check for one Trackpoint per sample and the Watts element).
- `test/e2e.mjs`: Playwright, `chromium.launch()` with no options (pre-installed), serve the folder with a tiny `http.createServer` on a free port (Web Bluetooth isn't needed in sim mode), run the scenario above, print PASS/FAIL lines, exit non-zero on failure.

## README.md (for Eric)

Short. What it is. Setup on iPad: install Bluefy (free), open the URL, bookmark it, Auto-Lock → Never. Before each ride: turn the trainer on, close the Wahoo app and Zwift, tap Connect Trainer, pick "KICKR CORE". First ride: Ramp Test. What the tests do and how FTP is set. What the buttons do. Where rides live (on the iPad, in Bluefy; export TCX to Strava/Garmin). Troubleshooting: "control not permitted" → close other apps, power-cycle the trainer; no cadence → Kickr Core estimates cadence from power, keep a steady stroke; firmware → update once in the Wahoo app.

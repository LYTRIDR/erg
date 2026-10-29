// ERG workout library. Plain script: defines globalThis.WORKOUTS.
//
// Step grammar (pct values are fractions of FTP, 0.90 = 90%):
//   [seconds, pct]                 steady ERG target
//   [seconds, fromPct, toPct]      linear ramp (target updated every second)
//   {reps: n, steps: [...]}        repeat the block n times
//   {free: seconds, grade: g}      free ride in sim mode (no ERG target), grade in %
//   {ramptest: true}               special: the ramp-test engine takes over (see SPEC.md)
// Optional 4th element on a steady step is a short voice cue, e.g. [120, 0.70, null, "spin it up, 100 rpm"].
// Durations are derived by flattening; never hand-write a total.
//
// Categories: test, recovery, endurance, tempo, sweetspot, threshold, vo2, anaerobic, tri, short, free

const WORKOUTS = [
  // ---------------- TESTS ----------------
  {
    id: "ramp", name: "Ramp Test", cat: "test",
    desc: "Start easy. Every minute the watts go up 20. Keep pedaling until you can't hold it. The app spots the moment you fail and sets your FTP from your best minute. 15 to 25 minutes. Do this first, then every 6 to 8 weeks.",
    steps: [{ramptest: true}]
  },
  {
    id: "ftp20", name: "20-Minute Test", cat: "test",
    desc: "The classic. Warm up with three one-minute openers and a five-minute hard effort, then 20 minutes as hard as you can hold evenly. The hard blocks are free-ride: you set the effort with your gears. FTP is 95% of your 20-minute average. More accurate than the ramp if you pace it well, and it hurts more.",
    steps: [
      [600, 0.50, 0.65],
      {reps: 3, steps: [[60, 1.00, null, "one minute, fast legs"], [60, 0.50]]},
      [300, 0.60],
      {free: 300, grade: 2, cue: "five minutes, hard"},
      [600, 0.50],
      {free: 1200, grade: 2, cue: "twenty minutes, all you have, steady"},
      [600, 0.45]
    ]
  },

  // ---------------- RECOVERY ----------------
  {
    id: "rec30", name: "Recovery Spin 30", cat: "recovery",
    desc: "Thirty minutes at 50%. Legs loose, nothing more. If it feels like training, it's too hard.",
    steps: [[300, 0.45, 0.52], [1200, 0.52], [300, 0.52, 0.45]]
  },
  {
    id: "rec45", name: "Recovery Spin 45", cat: "recovery",
    desc: "Forty-five minutes at 55%. The day after a hard one.",
    steps: [[300, 0.45, 0.55], [2100, 0.55], [300, 0.55, 0.45]]
  },

  // ---------------- ENDURANCE ----------------
  {
    id: "end45", name: "Endurance 45", cat: "endurance",
    desc: "Steady zone 2 at 68%. The bread and butter. You can talk the whole way.",
    steps: [[300, 0.50, 0.68], [2100, 0.68], [300, 0.68, 0.50]]
  },
  {
    id: "end60", name: "Endurance 60", cat: "endurance",
    desc: "An hour of zone 2 at 68%. Settle in and watch the show.",
    steps: [[300, 0.50, 0.68], [3000, 0.68], [300, 0.68, 0.50]]
  },
  {
    id: "end75", name: "Endurance 75", cat: "endurance",
    desc: "Seventy-five minutes at 68% with three five-minute lifts to 75% to keep you awake.",
    steps: [
      [300, 0.50, 0.68],
      {reps: 3, steps: [[900, 0.68], [300, 0.75, null, "five minutes a little firmer"]]},
      [300, 0.68],
      [300, 0.68, 0.50]
    ]
  },
  {
    id: "end90", name: "Endurance 90", cat: "endurance",
    desc: "Ninety minutes at 67%. The long one. Bring a bottle.",
    steps: [[300, 0.50, 0.67], [4800, 0.67], [300, 0.67, 0.50]]
  },
  {
    id: "endcad", name: "Endurance + Cadence 60", cat: "endurance",
    desc: "Zone 2 with six two-minute high-cadence blocks. Same watts, spin 100+ rpm when the cue says so. Smooths out your pedal stroke.",
    steps: [
      [300, 0.50, 0.68],
      {reps: 6, steps: [[120, 0.70, null, "two minutes, spin it up, 100 rpm"], [360, 0.68]]},
      [420, 0.68],
      [300, 0.68, 0.50]
    ]
  },

  // ---------------- TEMPO ----------------
  {
    id: "tempo3x10", name: "Tempo 3x10", cat: "tempo",
    desc: "Three ten-minute blocks at 80% with five easy between. Firm but sustainable. Good first hard-ish session back.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 3, steps: [[600, 0.80], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "tempo2x20", name: "Tempo 2x20", cat: "tempo",
    desc: "Two twenty-minute blocks at 82%. Long-course race pace territory. Stay aero if you can.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 2, steps: [[1200, 0.82], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },

  // ---------------- SWEET SPOT ----------------
  {
    id: "ss3x8", name: "Sweet Spot 3x8", cat: "sweetspot",
    desc: "Three eight-minute blocks at 90%, four easy between. The entry-level sweet spot session. Under an hour.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 3, steps: [[480, 0.90], [240, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "ss3x12", name: "Sweet Spot 3x12", cat: "sweetspot",
    desc: "Three twelve-minute blocks at 90%. The workhorse. Builds FTP without wrecking you.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 3, steps: [[720, 0.90], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "ss4x10", name: "Sweet Spot 4x10", cat: "sweetspot",
    desc: "Four ten-minute blocks at 91%, four easy between. About 70 minutes of real work.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 4, steps: [[600, 0.91], [240, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "ss2x20", name: "Sweet Spot 2x20", cat: "sweetspot",
    desc: "Two twenty-minute blocks at 90%, five easy between. The classic. If you can do this one comfortably, your FTP is probably higher than you think.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 2, steps: [[1200, 0.90], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "ss3x15", name: "Sweet Spot 3x15", cat: "sweetspot",
    desc: "Three fifteen-minute blocks at 88%. Longer and slightly easier. Good for half-Ironman legs.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 3, steps: [[900, 0.88], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },

  // ---------------- THRESHOLD ----------------
  {
    id: "thr2x15", name: "Threshold 2x15", cat: "threshold",
    desc: "Two fifteen-minute blocks at 98%, eight minutes easy between. Right at the edge. Breathing gets loud.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 2, steps: [[900, 0.98], [480, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "thr3x10", name: "Threshold 3x10", cat: "threshold",
    desc: "Three ten-minute blocks at 100%, five easy between. Thirty minutes at FTP in pieces.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 3, steps: [[600, 1.00], [300, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "thr4x8", name: "Threshold 4x8", cat: "threshold",
    desc: "Four eight-minute blocks at 100%, four easy between. Shorter pieces, same dose.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 4, steps: [[480, 1.00], [240, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "ou3x9", name: "Over-Unders 3x9", cat: "threshold",
    desc: "Three nine-minute blocks alternating two minutes at 95% and one minute at 105%. Teaches you to recover while still working. Five easy between.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 3, steps: [
        {reps: 3, steps: [[120, 0.95, null, "under"], [60, 1.05, null, "over"]]},
        [300, 0.50]
      ]},
      [300, 0.50, 0.45]
    ]
  },

  // ---------------- VO2 MAX ----------------
  {
    id: "vo2_5x3", name: "VO2 5x3", cat: "vo2",
    desc: "Five three-minute efforts at 118%, three minutes easy between. The standard VO2 session. The last two are the ones that count.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 5, steps: [[180, 1.18], [180, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "vo2_4x4", name: "VO2 4x4", cat: "vo2",
    desc: "Four four-minute efforts at 115%, four minutes easy between. The Norwegian one. Long enough to hurt properly.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 4, steps: [[240, 1.15], [240, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "vo2_6x2", name: "VO2 6x2", cat: "vo2",
    desc: "Six two-minute efforts at 125%, two minutes easy between. Short, sharp, top-end.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 6, steps: [[120, 1.25], [120, 0.50]]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "vo2_3030", name: "30/30s", cat: "vo2",
    desc: "Three sets of ten: 30 seconds at 130%, 30 seconds easy. Five minutes easy between sets. Lots of time at VO2 without any single effort feeling impossible.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 3, steps: [
        {reps: 10, steps: [[30, 1.30], [30, 0.50]]},
        [300, 0.50]
      ]},
      [300, 0.50, 0.45]
    ]
  },
  {
    id: "vo2_4020", name: "40/20s", cat: "vo2",
    desc: "Three sets of eight: 40 seconds at 125%, 20 seconds easy. Five minutes easy between sets. The 30/30s' meaner cousin.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 3, steps: [
        {reps: 8, steps: [[40, 1.25], [20, 0.50]]},
        [300, 0.50]
      ]},
      [300, 0.50, 0.45]
    ]
  },

  // ---------------- ANAEROBIC ----------------
  {
    id: "ana8x1", name: "Anaerobic 8x1", cat: "anaerobic",
    desc: "Eight one-minute efforts at 150%, three minutes easy between. Race surges and short climbs. Spin up before each one hits; the trainer takes a few seconds to load.",
    steps: [
      [600, 0.50, 0.75],
      {reps: 8, steps: [[60, 1.50], [180, 0.45]]},
      [300, 0.45]
    ]
  },

  // ---------------- TRIATHLON ----------------
  {
    id: "tri703", name: "70.3 Race Pace 2x20", cat: "tri",
    desc: "Two twenty-minute blocks at 80%, five easy between. Half-Ironman bike watts. Practice holding the aero position and drinking on schedule.",
    steps: [
      [600, 0.50, 0.70],
      {reps: 2, steps: [[1200, 0.80, null, "race pace, get aero"], [300, 0.55]]},
      [300, 0.55, 0.45]
    ]
  },
  {
    id: "trisprint", name: "Sprint Tri Race Sim", cat: "tri",
    desc: "Ten-minute build, then twenty minutes at 95%, the way a sprint-distance bike leg feels. Five easy to finish, or skip the cooldown and go run.",
    steps: [
      [600, 0.50, 0.80],
      [1200, 0.95, null, "twenty minutes, race effort"],
      [300, 0.50]
    ]
  },
  {
    id: "brick", name: "Brick Prep 45", cat: "tri",
    desc: "Fifteen at 70%, twenty at 85%, five at 95%, five easy. Then get off and run. Legs will feel like someone else's for the first mile; that's the point.",
    steps: [
      [900, 0.70],
      [1200, 0.85],
      [300, 0.95, null, "five minutes, push, then go run"],
      [300, 0.60]
    ]
  },

  // ---------------- SHORT ----------------
  {
    id: "quick20", name: "20-Minute Burner", cat: "short",
    desc: "Only have twenty minutes. Three-minute build, four times two minutes at 110% with one easy, five at 75% to finish. More work than it sounds.",
    steps: [
      [180, 0.50, 0.75],
      {reps: 4, steps: [[120, 1.10], [60, 0.50]]},
      [300, 0.75]
    ]
  },
  {
    id: "quick30", name: "30 Minutes, Done", cat: "short",
    desc: "Five up, twenty at 85%, five down. A solid half hour when that's all there is.",
    steps: [[300, 0.50, 0.75], [1200, 0.85], [300, 0.60, 0.45]]
  },

  // ---------------- FREE ----------------
  {
    id: "free", name: "Free Ride", cat: "free",
    desc: "No targets. Feels like a flat road; use the grade buttons to make it a hill. Ends when you end it. Still recorded.",
    steps: [{free: 7200, grade: 1}]
  }
];

const WORKOUT_CATEGORIES = [
  ["test", "Tests"],
  ["recovery", "Recovery"],
  ["endurance", "Endurance"],
  ["tempo", "Tempo"],
  ["sweetspot", "Sweet Spot"],
  ["threshold", "Threshold"],
  ["vo2", "VO2 Max"],
  ["anaerobic", "Anaerobic"],
  ["tri", "Triathlon"],
  ["short", "Short on Time"],
  ["free", "Free Ride"]
];

globalThis.WORKOUTS = WORKOUTS;
globalThis.WORKOUT_CATEGORIES = WORKOUT_CATEGORIES;
if (typeof module !== "undefined" && module.exports) module.exports = { WORKOUTS, WORKOUT_CATEGORIES };

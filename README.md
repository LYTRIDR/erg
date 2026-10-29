# ERG

A small web app that drives your Wahoo KICKR CORE (or any trainer that speaks
Bluetooth FTMS). You pick a workout, the trainer holds the watts for you, a
voice tells you what is coming, and the ride is saved so you can send it to
Strava or Garmin. No account, no subscription, nothing to install except a
browser.

## Set up the iPad (once)

1. Install **Bluefy** from the App Store. It is free. Safari on iPad cannot do
   Bluetooth, Bluefy can.
2. Open the app's web address in Bluefy and bookmark it.
   (The address has to start with `https://`. A page opened straight from a
   file will not get Bluetooth. GitHub Pages is a free place to put it.)
3. iPad **Settings > Display & Brightness > Auto-Lock > Never**, so the screen
   stays on during a ride. The app also asks the iPad to stay awake, but not
   every iPad listens.

## Before every ride

1. Plug the trainer in and wake it by turning the pedals for a few seconds.
2. Close the Wahoo app and Zwift. Only one app can control the trainer.
3. Open ERG in Bluefy and tap **Connect Trainer**. Pick **KICKR CORE**.
4. Optional: tap **Connect Heart Rate** and pick your strap.
5. Tap **Continue**, choose a workout, tap **Start**.

If the connection drops mid-ride the app tries to reconnect on its own. If it
gives up it says "Trainer lost. Tap Reconnect." The ride keeps its place.

## Your first ride: the Ramp Test

Do the **Ramp Test** first. It starts at 100 W and adds 20 W every minute. Keep
pedaling until you cannot hold the watts. The app notices when you drop off
(power falls well under target, or cadence collapses) and stops the test for
you. You can also tap **I'm done**. Then you get a 5-minute easy spin.

Your FTP is set to 75% of your best full minute. The app asks you to confirm
it on the summary screen. A test shorter than 5 minutes is "too short to
score" and changes nothing.

The **20-Minute Test** is the other way. After a warm-up you ride 5 minutes
hard and, after a rest, 20 minutes as hard as you can hold steadily. Those hard
blocks are free ride, so you choose the effort with your gears. FTP is 95% of
your 20-minute average.

Every other workout is built from percentages of FTP, so a good FTP makes all
of them the right size. Redo a test every 6 to 8 weeks. After a normal ride, if
your numbers say your FTP is a few percent higher, the summary offers to raise
it. It never lowers your FTP except after a test. You can also change it by hand
under **Settings**.

## On the ride screen

- **TARGET** is what the trainer is holding. **POWER** is your 3-second
  average. It turns the zone colour when you are within 5% of target.
- **Pause / Resume**: stops the clock and drops the trainer to an easy load.
- **Skip**: jumps to the next block. (**I'm done** during the Ramp Test.)
- **-5% / +5%**: makes the whole workout easier or harder. The badge at the top
  shows the percentage. In a free-ride block these buttons change the grade
  instead.
- **End**: tap twice ("End ride?" then "End") and you go to the summary.
- Voice and beeps: it tells you each block, says "Ten seconds" before a hard
  block ends, and beeps 3-2-1 before a harder block starts. Turn either off in
  Settings. The phone/iPad volume has to be up and the silent switch off.
- Auto-ease: if your cadence stays under 55 for 8 seconds in a hard block, the
  app takes 5% off and says so. Turn it off in Settings.

## Where your rides are

Rides are stored **on the iPad, inside Bluefy**. Nothing is uploaded. Clearing
Bluefy's website data (or deleting Bluefy) deletes them. To keep a ride, open it
from **History** and tap **Export TCX**. Share it to Files, mail it to yourself,
or upload the file to Strava or Garmin Connect.

## If something goes wrong

- **"Control not permitted" or the trainer will not take commands**: another
  app has it. Close the Wahoo app and Zwift (swipe them away), unplug the
  trainer for 10 seconds, plug it back in, wake it with the pedals, then Connect
  Trainer again.
- **No cadence number**: the KICKR CORE estimates cadence from power and does
  not always send it. A steady, round stroke helps. Cadence-based auto-ease
  does nothing without it.
- **The trainer feels wrong or will not connect at all**: update its firmware
  once in the Wahoo app, then close that app.
- **No sound**: check volume and the silent switch. Voice and beeps start only
  after you tap Start.
- **Want to see it without a trainer?** Tap **Ride without trainer** on a
  workout page (the clock runs, nothing is recorded). Adding `?sim=1` to the
  address gives you a fake trainer with made-up power, for poking at the
  screens.

## For tinkerers

Plain files, no build step: `index.html` (the app), `core.js` (the maths and
Bluetooth byte handling), `workouts.js` (the workout list). Tests:

    node --test test/        # unit tests, about a second
    node test/e2e.mjs        # full simulated rides in a headless browser, ~2 minutes

Add `?sim=1` to the address for a fake trainer, and `&speed=60` to run it at 60
times speed.

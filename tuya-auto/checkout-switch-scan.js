process.chdir(__dirname); // ensure relative paths (.env, unit-switches.json, state file) resolve correctly under pm2

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { checkDeviceOn, checkDeviceOnline } = require('./tuya-lib');

// ---------- Config ----------
const BOOKINGS_DB_PATH = 'C:\\apps\\shared-data\\bookings.db'; // same DB the booking system uses
const UNIT_SWITCHES_PATH = path.join(__dirname, 'unit-switches.json');
const UNIT_HEALTH_DEVICES_PATH = path.join(__dirname, 'unit-health-devices.json');
const STATE_PATH = path.join(__dirname, 'checkout-scan-state.json');
const HEALTH_STATE_PATH = path.join(__dirname, 'health-check-state.json');
const OUTBOX_DIR = 'C:\\apps\\shared-data\\wa-outbox'; // same outbox whatsapp-bot already watches

// Small delay between each unit's device checks, in BOTH jobs below.
// Confirmed via testing on 2026-08-05 that running both jobs' full device
// lists concurrently (each already sequential unit-by-unit, but the two
// jobs overlapping in real time doubles the effective request rate) can
// burst past Tuya's rate limit - one device came back unreadable under
// that load despite being fine on manual retry seconds later. This stagger
// plus the retry in tuya-lib.js are both defenses against the same root
// cause; keep both rather than relying on just one.
const UNIT_STAGGER_MS = 400;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real housekeeping group - "Boston SGR Swiss Garden". Confirmed against
// whatsapp-bot's own config.js, which already has this exact JID as its
// default housekeepingGroupJid.
const HOUSEKEEPING_GROUP_JID = '120363424480363759@g.us'; // "Boston SGR Swiss Garden"

// Testing group - "Boston Check In Out" (same group the nightly checkout
// report sends to). Set TEST_MODE=1 in the environment to route alerts
// here instead, with a [TEST] prefix, while you verify the pipeline end
// to end before pointing it at the real housekeeping group.
const TEST_GROUP_JID = '120363402060306853@g.us'; // "Boston Check In Out"
const TEST_MODE = process.env.TEST_MODE === '1';
const TARGET_GROUP_JID = TEST_MODE ? TEST_GROUP_JID : HOUSEKEEPING_GROUP_JID;

// Staff-group sends via the bot's sendStaffText() do NOT auto-append the
// " (bot)" suffix (only guest-facing replies via sendGuestText() do - see
// whatsapp-bot's sender.js/config.js botSuffix). The existing checkout
// report works around this by appending it manually; do the same here.
const BOT_SUFFIX = ' (bot)';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - checks whether it's time to run
const ALERT_TIME_SLOTS = ['09:00', '09:30', '10:00', '10:30']; // 11:00 = official checkout, no need to alert after

// FORCE_RUN=1 bypasses the time-slot check entirely, for manual testing
// outside 9-10:30AM. When set, the scan still runs for real (real DB, real
// Tuya reads, real outbox write if something's confirmed) but deliberately
// does NOT persist to checkout-scan-state.json - so a test run can never
// mark a room "already alerted today" and accidentally suppress a real
// alert later during the actual 9-10:30AM window. Combine with TEST_MODE=1
// so any real alert still goes to the test group, not real housekeeping.
const FORCE_RUN = process.env.FORCE_RUN === '1';

// Same idea, separate flag, for the device health check below (independent
// of the occupancy scan's own FORCE_RUN, so you can test one without
// forcing the other).
const HEALTH_CHECK_HOUR = 9; // 9AM local time, once per day (not repeating like the checkout scan)
const FORCE_HEALTH_RUN = process.env.FORCE_HEALTH_RUN === '1';

// LOUD startup warning if any test flag is active - this exists because a
// real incident happened on 2026-08-05: leftover $env:TEST_MODE/$env:FORCE_RUN
// from a manual PowerShell test session got inherited by `pm2 start` in the
// same window, silently running "production" with FORCE_RUN active - which
// bypasses the time-slot check AND skips saving state, so it re-sent an
// alert every single 5-minute poll instead of once. Impossible to miss this
// in `pm2 logs` now.
if (TEST_MODE || FORCE_RUN || FORCE_HEALTH_RUN) {
  console.log('='.repeat(70));
  console.log('WARNING: test flag(s) active in this process:');
  if (TEST_MODE) console.log('  TEST_MODE=1        -> sending to TEST group, not real housekeeping');
  if (FORCE_RUN) console.log('  FORCE_RUN=1         -> occupancy scan bypasses time-slot check, ' +
    'will re-scan and may re-alert EVERY poll cycle (every ' + (POLL_INTERVAL_MS / 60000) + ' min)');
  if (FORCE_HEALTH_RUN) console.log('  FORCE_HEALTH_RUN=1  -> health check bypasses the once-daily check, ' +
    'will re-scan and may re-alert EVERY poll cycle');
  console.log('If this is running under pm2 and you did NOT intend this, stop it now:');
  console.log('  pm2 delete checkout-switch-scan');
  console.log('then clear these vars from your shell session before restarting pm2.');
  console.log('='.repeat(70));
}

// ---------- State (persisted so a pm2 restart never double-sends or re-scans a slot) ----------
function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  }
  return { date: null, slotsSent: [], alertedRooms: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadHealthState() {
  if (fs.existsSync(HEALTH_STATE_PATH)) {
    return JSON.parse(fs.readFileSync(HEALTH_STATE_PATH, 'utf8'));
  }
  return { lastSentDate: null };
}

function saveHealthState(state) {
  fs.writeFileSync(HEALTH_STATE_PATH, JSON.stringify(state, null, 2));
}

function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentSlot(now) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = now.getMinutes() < 30 ? '00' : '30';
  return `${hh}:${mm}`;
}

// ---------- Outbox (identical convention to the booking system's writeOutboxMessage) ----------
function writeOutboxMessage(groupJid, message) {
  if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const filename = `checkout-switch-scan-${Date.now()}.json`;
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), JSON.stringify({ groupJid, message }), 'utf8');
  return filename;
}

// ---------- Core scan ----------
async function runScan() {
  const now = new Date();
  const todayIso = toLocalISODate(now);
  const slot = currentSlot(now);

  if (!FORCE_RUN && !ALERT_TIME_SLOTS.includes(slot)) return; // not one of our check times

  let state = loadState();
  if (state.date !== todayIso) {
    state = { date: todayIso, slotsSent: [], alertedRooms: [] }; // new day, reset
  }
  if (!FORCE_RUN && state.slotsSent.includes(slot)) return; // already ran this slot today (pm2 restart safety)

  console.log(`[${now.toISOString()}] Checkout switch scan starting (slot ${slot}${FORCE_RUN ? ', FORCED manual run - state will NOT be saved' : ''})...`);

  try {
    const unitSwitchMap = JSON.parse(fs.readFileSync(UNIT_SWITCHES_PATH, 'utf8')).units;
    const db = new Database(BOOKINGS_DB_PATH, { readonly: true });

    const todaysCheckouts = db
      .prepare(`SELECT booking_number, assigned_room, guest_name FROM bookings
                WHERE status != 'cancelled' AND check_out = ? AND assigned_room IS NOT NULL`)
      .all(todayIso);
    db.close();

    const candidateRooms = [...new Set(todaysCheckouts.map((b) => b.assigned_room))]
      .filter((room) => !state.alertedRooms.includes(room)); // skip rooms already confirmed+alerted earlier today

    const newlyConfirmed = [];

    for (const room of candidateRooms) {
      const devices = unitSwitchMap[room];
      if (!devices || devices.length === 0) {
        console.log(`  ${room}: no Tuya switches mapped for this unit (TTLock unit or not in spreadsheet) - skipping.`);
        continue;
      }

      const results = await Promise.all(devices.map((d) => checkDeviceOn(d.device_id, `${room} / ${d.name}`)));
      await sleep(UNIT_STAGGER_MS);

      const anyOn = results.some((r) => r.state === 'on');
      const anyUnknownOrError = results.some((r) => r.state === 'unknown' || r.state === 'error');

      if (anyOn) {
        console.log(`  ${room}: still ON (${results.filter((r) => r.state === 'on').map((r) => r.label).join(', ')}) - guest likely still inside.`);
        continue;
      }
      if (anyUnknownOrError) {
        // Fail-safe: don't guess "vacated" if we couldn't read every device confidently.
        console.log(`  ${room}: could not confirm all switches (unknown/error reading) - not alerting, will retry next slot.`, results);
        continue;
      }

      console.log(`  ${room}: ALL switches OFF - guest likely checked out.`);
      newlyConfirmed.push(room);
    }

    if (newlyConfirmed.length > 0) {
      const base = `${newlyConfirmed.join(', ')} no AC`;
      const message = (TEST_MODE ? '[TEST] ' : '') + base + BOT_SUFFIX;
      writeOutboxMessage(TARGET_GROUP_JID, message);
      console.log(`[${now.toISOString()}] Sent ${TEST_MODE ? 'TEST ' : ''}alert to ${TARGET_GROUP_JID}: "${message}"`);
      state.alertedRooms.push(...newlyConfirmed);
    } else {
      console.log(`[${now.toISOString()}] No newly-confirmed vacated rooms this slot.`);
    }

    if (FORCE_RUN) {
      console.log(`[${now.toISOString()}] FORCE_RUN - not saving state (this run does not count as today's real ${slot} check).`);
    } else {
      state.slotsSent.push(slot);
      saveState(state);
    }
  } catch (err) {
    console.error(`[${now.toISOString()}] Checkout switch scan error:`, err.message);
  }
}

console.log(`Checkout switch scan starting. Will check every ${POLL_INTERVAL_MS / 60000} minutes, ` +
  `only acts during slots: ${ALERT_TIME_SLOTS.join(', ')}.`);
runScan();
setInterval(runScan, POLL_INTERVAL_MS);

// ---------- Device connectivity/health check (once daily at 9AM, ALL units regardless of checkout) ----------
// Separate concern from occupancy detection above: this checks whether
// each AC/Shower/Heater/Door-sensor device is actually reachable on wifi
// right now, not whether it's on or off. A device the automation depends
// on (e.g. the door sensor that triggers auto-off) going offline is worth
// knowing about even with no checkout happening that day - hence scanning
// ALL units, not just today's checkouts.
async function runDeviceHealthCheck() {
  const now = new Date();
  const todayIso = toLocalISODate(now);

  if (!FORCE_HEALTH_RUN) {
    if (now.getHours() !== HEALTH_CHECK_HOUR) return; // only fire during the 9AM hour
    const state = loadHealthState();
    if (state.lastSentDate === todayIso) return; // already ran today (pm2 restart safety)
  }

  console.log(`[${now.toISOString()}] Device health check starting${FORCE_HEALTH_RUN ? ' (FORCED manual run - state will NOT be saved)' : ''}...`);

  try {
    const unitHealthMap = JSON.parse(fs.readFileSync(UNIT_HEALTH_DEVICES_PATH, 'utf8')).units;
    const offlineByUnit = {};

    for (const unit of Object.keys(unitHealthMap)) {
      const devices = unitHealthMap[unit];
      const results = await Promise.all(devices.map((d) => checkDeviceOnline(d.device_id, `${unit} / ${d.name}`)));
      await sleep(UNIT_STAGGER_MS);

      const offline = results.filter((r) => r.online === false);
      const unreadable = results.filter((r) => r.online === null);

      if (offline.length > 0) {
        offlineByUnit[unit] = offline.map((r) => r.label.split(' / ')[1]); // just the device name part
        console.log(`  ${unit}: OFFLINE - ${offlineByUnit[unit].join(', ')}`);
      }
      if (unreadable.length > 0) {
        // Fail-safe: an unreadable response is NOT the same as confirmed
        // offline - don't alert on it, just log for manual follow-up.
        console.log(`  ${unit}: could not confirm online status for: ${unreadable.map((r) => r.label).join(', ')}`);
      }
    }

    const affectedUnits = Object.keys(offlineByUnit);
    if (affectedUnits.length > 0) {
      const lines = affectedUnits.map((u) => `${u}: ${offlineByUnit[u].join(', ')}`);
      const base = `⚠ Device(s) offline, need wifi reset:\n${lines.join('\n')}`;
      const message = (TEST_MODE ? '[TEST] ' : '') + base + BOT_SUFFIX;
      writeOutboxMessage(TARGET_GROUP_JID, message);
      console.log(`[${now.toISOString()}] Sent ${TEST_MODE ? 'TEST ' : ''}offline-device alert to ${TARGET_GROUP_JID}: "${message}"`);
    } else {
      console.log(`[${now.toISOString()}] All devices online, nothing to alert.`);
    }

    if (FORCE_HEALTH_RUN) {
      console.log(`[${now.toISOString()}] FORCE_HEALTH_RUN - not saving state (this run does not count as today's real check).`);
    } else {
      saveHealthState({ lastSentDate: todayIso });
    }
  } catch (err) {
    console.error(`[${now.toISOString()}] Device health check error:`, err.message);
  }
}

console.log(`Device health check starting. Will check every ${POLL_INTERVAL_MS / 60000} minutes, ` +
  `sends once during the ${HEALTH_CHECK_HOUR}:00 hour if anything's offline.`);
if (FORCE_HEALTH_RUN) {
  // Testing - run immediately, no point waiting on the stagger offset below.
  runDeviceHealthCheck();
  setInterval(runDeviceHealthCheck, POLL_INTERVAL_MS);
} else {
  // Production - offset this job's polling tick from the occupancy scan's
  // by half the poll interval, so the two jobs' request bursts don't
  // always land at exactly the same moment (see UNIT_STAGGER_MS comment
  // above for why that matters).
  setTimeout(() => {
    runDeviceHealthCheck();
    setInterval(runDeviceHealthCheck, POLL_INTERVAL_MS);
  }, POLL_INTERVAL_MS / 2);
}

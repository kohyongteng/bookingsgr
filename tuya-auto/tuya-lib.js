/**
 * tuya-lib.js
 * Minimal Tuya helper for the checkout-detection scanner.
 *
 * This is READ-ONLY - it only calls the device status endpoint, never
 * anything under door-lock/*. Reading status does not require
 * "Controllable" permission and does NOT count against the Trial
 * Edition's 10-controllable-device cap (that cap is about the 10 locks
 * in the separate lock-passcode project, files_lock/). Safe to run
 * against all switch devices regardless of their permission level.
 */

require('dotenv').config();
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_BASE_URL,
  accessKey: process.env.TUYA_CLIENT_ID,
  secretKey: process.env.TUYA_CLIENT_SECRET,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function once after a short delay if it throws or
 * returns a falsy/failure result. Exists because running both scheduled
 * jobs' full device lists through Promise.all can burst 80-100+ requests
 * at Tuya nearly simultaneously (confirmed in testing on 2026-08-05 - one
 * device out of ~100 came back unreadable under that burst, succeeded
 * immediately on manual retry) - almost certainly a Tuya API rate limit,
 * not a real device problem. One retry after a brief pause clears it.
 */
async function withRetry(fn, { retries = 1, delayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Runs async fn over items with at most `limit` in flight at once, instead
 * of an unbounded Promise.all - keeps us from bursting the Tuya API and
 * hitting rate limits in the first place (see withRetry comment above for
 * what happens when we don't).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Raw status array for a device, e.g. [{ code: 'switch_1', value: true }, ...] */
async function getDeviceStatus(deviceId) {
  return tuya.request({ method: 'GET', path: `/v1.0/devices/${deviceId}/status` });
}

/**
 * Get device DETAILS (not status) - includes an `online` boolean, which is
 * what the connectivity/health check needs (is this device actually
 * reachable on wifi right now), as opposed to getDeviceStatus() above
 * which is about the switch's last-known on/off state.
 * NOT YET VERIFIED against a live device - run test-device-online.js once
 * to confirm the response really has an `online` field before trusting
 * checkDeviceOnline() below.
 */
async function getDeviceInfo(deviceId) {
  return tuya.request({ method: 'GET', path: `/v1.0/devices/${deviceId}` });
}

/**
 * Checks whether a device is online/reachable.
 * Returns { label, deviceId, online: true|false|null, detail }
 * online: null means the API response didn't have the field we expected -
 * treat as "can't confirm", don't alert on it, and go check the raw
 * response with test-device-online.js.
 */
async function checkDeviceOnline(deviceId, label) {
  try {
    const res = await withRetry(async () => {
      const r = await getDeviceInfo(deviceId);
      if (!r.success) throw new Error(`API returned failure: ${JSON.stringify(r)}`);
      return r;
    });
    if (typeof res.result.online !== 'boolean') {
      return { label, deviceId, online: null, detail: JSON.stringify(res.result) };
    }
    return { label, deviceId, online: res.result.online, detail: null };
  } catch (err) {
    return { label, deviceId, online: null, detail: err.message };
  }
}

/**
 * Inspects a device's status array and decides ON / OFF / UNKNOWN.
 *
 * We don't hardcode a single status code name because the switch devices
 * in unit-switches.json are a mix of product types (CB01-SBL, the
 * "WIFI热水器开关" water-heater-switch model, T1-3S-1, etc.) and different
 * Tuya product types can expose the on/off flag under different codes
 * (switch_1, switch, switch_2, etc). We match ONLY the real relay/power
 * codes: bare "switch" or "switch_<number>" (switch_1, switch_2, ...).
 *
 * IMPORTANT: confirmed via test-device-status.js (2026-08-05 real output)
 * that these devices also report a "switch_backlight" field - the LED
 * indicator light on the physical switch faceplate, NOT the AC/heater
 * power state itself. It's often true even when switch_1 (real power) is
 * false. An earlier version of this function matched any code containing
 * "switch" and was fooled by this - it reported ON for a unit whose AC
 * was actually OFF. Do not broaden this regex back to a loose /switch/i
 * match without re-checking against switch_backlight and switch_inching
 * (a pulse-mode config field, also not a power state) again.
 *
 * Returns { state: 'on'|'off'|'unknown', matchedCodes: [...], raw: [...] }
 * 'unknown' means we couldn't find a real switch_N code at all - callers
 * should treat this as "can't confirm OFF" and NOT alert, rather than
 * guessing. Run test-device-status.js once per product type to confirm
 * the real code name before trusting this in production.
 */
function interpretSwitchStatus(statusArray) {
  if (!Array.isArray(statusArray)) {
    return { state: 'unknown', matchedCodes: [], raw: statusArray };
  }
  const switchFields = statusArray.filter(
    (s) => typeof s.value === 'boolean' && /^switch(_\d+)?$/i.test(s.code)
  );
  if (switchFields.length === 0) {
    return { state: 'unknown', matchedCodes: [], raw: statusArray };
  }
  const anyOn = switchFields.some((s) => s.value === true);
  return {
    state: anyOn ? 'on' : 'off',
    matchedCodes: switchFields.map((s) => s.code),
    raw: statusArray,
  };
}

/**
 * Checks one device end-to-end: fetches status, interprets it.
 * Never throws for a single bad device - returns state 'error' instead,
 * so one flaky/offline device can't crash a whole scan cycle.
 */
async function checkDeviceOn(deviceId, label) {
  try {
    const res = await withRetry(async () => {
      const r = await getDeviceStatus(deviceId);
      if (!r.success) throw new Error(`API returned failure: ${JSON.stringify(r)}`);
      return r;
    });
    const interpreted = interpretSwitchStatus(res.result);
    return { label, deviceId, ...interpreted };
  } catch (err) {
    return { label, deviceId, state: 'error', detail: err.message };
  }
}

module.exports = {
  getDeviceStatus,
  interpretSwitchStatus,
  checkDeviceOn,
  getDeviceInfo,
  checkDeviceOnline,
  mapWithConcurrency,
};

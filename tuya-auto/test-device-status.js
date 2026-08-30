/**
 * test-device-status.js
 * Run this FIRST, before trusting checkout-switch-scan.js.
 *
 * Prints the raw Tuya status response for one device per PRODUCT TYPE
 * found in unit-switches.json, plus what interpretSwitchStatus() decides
 * for each. Check that:
 *   1. Every device shows a code containing "switch" (not e.g. "cur_power"
 *      or something else entirely) - if not, interpretSwitchStatus()
 *      needs an extra pattern for that product.
 *   2. The 'state' (on/off) it prints actually matches reality - e.g. go
 *      check the aircon is physically on/off and compare.
 *
 * Usage:
 *   node test-device-status.js            (tests one sample device per product type)
 *   node test-device-status.js <deviceId> (tests just that one device)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDeviceStatus, interpretSwitchStatus } = require('./tuya-lib');

async function testOne(deviceId, label) {
  console.log(`\n--- ${label || ''} (${deviceId}) ---`);
  try {
    const res = await getDeviceStatus(deviceId);
    if (!res.success) {
      console.log('  API returned failure:', JSON.stringify(res));
      return;
    }
    console.log('  Raw status:', JSON.stringify(res.result));
    const interpreted = interpretSwitchStatus(res.result);
    console.log(`  => Interpreted state: ${interpreted.state.toUpperCase()}` +
      (interpreted.matchedCodes.length ? ` (matched codes: ${interpreted.matchedCodes.join(', ')})` : ' (no switch-like code found!)'));
  } catch (err) {
    console.log('  Error:', err.message);
  }
}

async function main() {
  const argDeviceId = process.argv[2];

  if (argDeviceId) {
    await testOne(argDeviceId, 'manual test');
    return;
  }

  const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'unit-switches.json'), 'utf8'));
  const seenProducts = new Set();
  const samples = [];

  for (const unit of Object.keys(map.units)) {
    for (const device of map.units[unit]) {
      if (!seenProducts.has(device.product)) {
        seenProducts.add(device.product);
        samples.push({ ...device, unit });
      }
    }
  }

  console.log(`Testing ${samples.length} sample device(s), one per distinct product type...`);
  for (const s of samples) {
    await testOne(s.device_id, `${s.unit} / ${s.name} / product: ${s.product}`);
  }
}

main();

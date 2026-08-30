/**
 * test-device-online.js
 * Run this before trusting device-health-check.js.
 *
 * Prints the raw Tuya device-details response (GET /v1.0/devices/{id})
 * for one sample device per product type in unit-health-devices.json,
 * plus what checkDeviceOnline() decides. Check that every device shows
 * a boolean `online` field - if not, checkDeviceOnline() needs updating
 * for that product/response shape.
 *
 * Usage:
 *   node test-device-online.js            (tests one sample device per product type)
 *   node test-device-online.js <deviceId> (tests just that one device)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDeviceInfo, checkDeviceOnline } = require('./tuya-lib');

async function testOne(deviceId, label) {
  console.log(`\n--- ${label || ''} (${deviceId}) ---`);
  try {
    const res = await getDeviceInfo(deviceId);
    if (!res.success) {
      console.log('  API returned failure:', JSON.stringify(res));
      return;
    }
    console.log('  Raw device info:', JSON.stringify(res.result));
    const interpreted = await checkDeviceOnline(deviceId, label);
    console.log(`  => Interpreted online: ${interpreted.online === null ? 'UNKNOWN (no boolean online field found!)' : interpreted.online}`);
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

  const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'unit-health-devices.json'), 'utf8'));
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

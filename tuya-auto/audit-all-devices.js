/**
 * audit-all-devices.js
 * Run this ONCE before going live, and again any time you regenerate the
 * device mapping JSON files from a fresh spreadsheet export.
 *
 * Checks EVERY device ID in both unit-switches.json and
 * unit-health-devices.json against Tuya directly (via getDeviceInfo).
 * This exists because a real typo was found this way on 2026-08-05:
 * "S2703 AC Living" had a device ID off by one digit in the source
 * spreadsheet, and Tuya's error for that ("permission deny", code 1106)
 * looked exactly like a real authorization problem rather than a typo -
 * there was no way to tell the difference without checking. This script
 * checks all ~90 device IDs at once instead of finding typos one at a
 * time as they happen to come up during daily use.
 *
 * Usage:
 *   node audit-all-devices.js
 *
 * For each FAIL, go to iot.tuya.com -> Cloud -> [your project] -> Devices,
 * search for the unit/device name, and compare the device_id shown there
 * against what's printed here. If they differ, that's a typo - fix it in
 * the relevant JSON file. If they're identical, it's a real
 * authorization/permission gap on Tuya's side, not a data error.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { checkDeviceOnline } = require('./tuya-lib');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const files = ['unit-switches.json', 'unit-health-devices.json'];
  const allDevices = []; // { source, unit, name, device_id }

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    for (const unit of Object.keys(data.units)) {
      for (const d of data.units[unit]) {
        allDevices.push({ source: file, unit, name: d.name, device_id: d.device_id });
      }
    }
  }

  // Dedupe by device_id so a device appearing in both files is only
  // checked once against the API, but we keep track of every label it
  // appears under for the report.
  const byId = new Map();
  for (const d of allDevices) {
    if (!byId.has(d.device_id)) byId.set(d.device_id, { device_id: d.device_id, labels: [] });
    byId.get(d.device_id).labels.push(`${d.unit} / ${d.name} (${d.source})`);
  }
  const uniqueDevices = [...byId.values()];

  console.log(`Auditing ${uniqueDevices.length} unique device ID(s) (${allDevices.length} total label(s) across both files)...\n`);

  const failures = [];
  let passCount = 0;

  for (const d of uniqueDevices) {
    const result = await checkDeviceOnline(d.device_id, d.labels.join(' / '));
    if (result.online === null) {
      failures.push({ ...d, detail: result.detail });
      console.log(`FAIL  ${d.device_id}  ${d.labels.join('; ')}\n      ${result.detail}`);
    } else {
      passCount++;
    }
    await sleep(300); // stay well under Tuya's rate limit for a ~90-device sequential audit
  }

  console.log(`\n---\n${passCount} device(s) OK. ${failures.length} device(s) FAILED.`);
  if (failures.length > 0) {
    console.log(`\nFor each FAIL above: check iot.tuya.com -> Cloud -> your project -> Devices,`);
    console.log(`search by unit/device name, and compare the device_id shown there against`);
    console.log(`the one printed here. Mismatch = typo in the spreadsheet/JSON (fix the ID).`);
    console.log(`Exact match = genuine permission/authorization gap on Tuya's side.`);
  }
}

main();

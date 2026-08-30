// switch-to-ttlock.js
//
// Switches one or more units from Tuya to TTLock in devices.json.
// Fill in the real lockId for each unit below (from list-ttlock-locks.js)
// before running - the placeholders will make the script abort safely
// if you forget to fill one in.
//
// doorNumber and location are preserved automatically from the existing
// Tuya entry - only system + the lock identifier actually change.
//
// Safe to re-run.
//
// Usage (in C:\Lock\guest-passcode):
//   node switch-to-ttlock.js

const fs = require('fs');

const DEVICES_JSON_PATH = 'C:\\apps\\guest-passcode\\devices.json';

// --- Fill in the real TTLock lockId for each unit below ---
const SWITCHES = {
  N1101: 34607752, // S8503_43c349
  S2806: 34610066, // S8503_6f614a
  N3001: 34605008, // S8503_89b61a
};

const devices = JSON.parse(fs.readFileSync(DEVICES_JSON_PATH, 'utf8'));

const missing = Object.entries(SWITCHES).filter(([, id]) => id === null);
if (missing.length > 0) {
  console.error('ABORTED: still missing lockId for: ' + missing.map(([u]) => u).join(', '));
  console.error('Fill in the SWITCHES object at the top of this script first.');
  process.exit(1);
}

for (const [unit, lockId] of Object.entries(SWITCHES)) {
  const existing = devices.units.find((u) => u.unit === unit);
  if (!existing) {
    console.error(`WARNING: ${unit} not found in devices.json - skipping.`);
    continue;
  }
  if (existing.system !== 'tuya') {
    console.log(`${unit} is already "${existing.system}", not "tuya" - skipping.`);
    continue;
  }

  console.log(`${unit}: switching tuya -> ttlock (lockId ${lockId})`);
  delete existing.lock_device_id;
  existing.system = 'ttlock';
  existing.lock_id = lockId;
  // doorNumber and location are left exactly as they were.
}

fs.writeFileSync(DEVICES_JSON_PATH, JSON.stringify(devices, null, 2) + '\n');

console.log('\nFinal entries:');
for (const unit of Object.keys(SWITCHES)) {
  const u = devices.units.find((x) => x.unit === unit);
  console.log(JSON.stringify(u, null, 2));
}

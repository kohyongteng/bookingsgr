// fix-s2103-to-ttlock.js
//
// Corrects the S2103 devices.json entry: removes the earlier Tuya-style
// entry (wrong - the lock was switched to TTLock today) and adds the
// correct ttlock entry instead.
//
// Edit CONFIRMED_LOCK_ID below if the TTLock app check turns up a
// different lockId than the one found by elimination (34258742).
//
// Safe to re-run.
//
// Usage (on the mini PC):
//   node fix-s2103-to-ttlock.js

const fs = require('fs');

const DEVICES_JSON_PATH = 'C:\\apps\\guest-passcode\\devices.json';
const CONFIRMED_LOCK_ID = 34258742; // <-- update if the TTLock app check disagrees

const devices = JSON.parse(fs.readFileSync(DEVICES_JSON_PATH, 'utf8'));

const beforeCount = devices.units.length;
devices.units = devices.units.filter((u) => u.unit !== 'S2103');
const removed = beforeCount - devices.units.length;
console.log(removed > 0 ? 'Removed old S2103 entry (Tuya).' : 'No existing S2103 entry found to remove.');

devices.units.push({
  unit: 'S2103',
  system: 'ttlock',
  lock_id: CONFIRMED_LOCK_ID,
  doorNumber: '22103', // still unconfirmed against the physical door - see earlier note
  location: 'South Tower, Level 21, Unit 22103',
});
console.log(`Added S2103 as ttlock, lock_id: ${CONFIRMED_LOCK_ID}`);

fs.writeFileSync(DEVICES_JSON_PATH, JSON.stringify(devices, null, 2) + '\n');

console.log('\nFinal S2103 entry:');
console.log(JSON.stringify(devices.units.find((u) => u.unit === 'S2103'), null, 2));

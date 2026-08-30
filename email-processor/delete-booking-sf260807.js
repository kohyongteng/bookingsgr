// delete-booking-sf260807.js
//
// Directly deletes the confirmed-orphaned SF260807 stub (NOT SF260807A -
// that one is the real, correct booking and must not be touched).
//
// Usage (on the mini PC):
//   node delete-booking-sf260807.js

const Database = require('better-sqlite3');

const DB_PATH = 'C:\\apps\\shared-data\\bookings.db';
const BOOKING_NUMBER = 'SF260807'; // exact match only - will NOT touch SF260807A

const db = new Database(DB_PATH); // NOT readonly this time - this one writes

const before = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
if (!before) {
  console.log(`No row found with booking_number = "${BOOKING_NUMBER}" - nothing to delete (already gone?).`);
} else {
  console.log('About to delete this row:');
  console.log(JSON.stringify(before, null, 2));

  const result = db.prepare('DELETE FROM bookings WHERE booking_number = ?').run(BOOKING_NUMBER);
  console.log(`\nDeleted ${result.changes} row(s).`);

  const after = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
  console.log(after ? 'WARNING: row still present after delete!' : 'Confirmed: row is gone.');
}

// Sanity check - confirm the GOOD booking is still untouched.
const stillGood = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get('SF260807A');
console.log('\nSF260807A (should be untouched):', stillGood ? 'still present, OK' : 'MISSING - something is very wrong');

db.close();

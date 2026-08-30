// One-off correction for the year-inference bug (see airbnbInferYear fix in lib.js).
// This booking's check-in got parsed as 2027-08-03 instead of 2026-08-03 because it
// was a same-day last-minute booking. Run this once on the mini PC after deploying
// the fixed lib.js, then this script can be deleted.
const lib = require('./lib');

const BOOKING_NUMBER = 'HMW3AYNRDP';
const CORRECT_CHECK_IN = '2026-08-03';

const db = lib.openDb();
const before = db.prepare('SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
console.log('Before:', before);

if (!before) {
  console.log('Booking not found - nothing to fix.');
} else if (before.check_in === CORRECT_CHECK_IN) {
  console.log('Already correct - nothing to fix.');
} else {
  db.prepare('UPDATE bookings SET check_in = ?, updated_at = CURRENT_TIMESTAMP WHERE booking_number = ?')
    .run(CORRECT_CHECK_IN, BOOKING_NUMBER);
  const after = db.prepare('SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
  console.log('After:', after);
  console.log('Fixed. The 5-minute calendar sync cycle will pick this up automatically and create/update the Google Calendar events.');
}

db.close();

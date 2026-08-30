// One-off correction for the guest-name regex bug (see scraper-service.js fix).
// This booking scraped correctly except the guest name, because "Wörner" contains
// a non-ASCII character the old regex couldn't match at all. Run this once on the
// mini PC after deploying the fixed scraper-service.js, then delete this script.
const lib = require('./lib');

const BOOKING_NUMBER = '6890095151';
const CORRECT_GUEST_NAME = 'Raffael Wörner';

const db = lib.openDb();
const before = db.prepare('SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
console.log('Before:', before);

if (!before) {
  console.log('Booking not found - nothing to fix.');
} else if (before.guest_name === CORRECT_GUEST_NAME) {
  console.log('Already correct - nothing to fix.');
} else {
  db.prepare('UPDATE bookings SET guest_name = ?, updated_at = CURRENT_TIMESTAMP WHERE booking_number = ?')
    .run(CORRECT_GUEST_NAME, BOOKING_NUMBER);
  const after = db.prepare('SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
  console.log('After:', after);
  console.log('Fixed.');
}

db.close();

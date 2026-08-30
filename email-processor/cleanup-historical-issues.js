// One-time cleanup of historical junk rows that are safe to delete:
//   1. Airbnb bookings from the July 31 backfill batch that are missing
//      check-in/check-out entirely (the old-email-format date bug - now fixed
//      in lib.js, but these specific rows were already saved with null dates).
//      All confirmed to have check-in dates well before today.
//   2. Booking.com bookings with a missing guest name whose stay has ALREADY
//      finished (check-out before today) - the still-upcoming ones are left
//      alone and get fixed by fix-missing-guestnames.js instead.
//
// Prints exactly what it's about to delete BEFORE deleting, for a final look.
const lib = require('./lib');

function todayIso() {
  return lib.toLocalISODate(new Date());
}

async function main() {
  const db = lib.openDb();
  const today = todayIso();

  const missingDatesRows = db
    .prepare(`
      SELECT booking_number, guest_name FROM bookings
      WHERE platform = 'airbnb' AND status != 'cancelled'
      AND (check_in IS NULL OR check_out IS NULL)
    `)
    .all();

  const missingNameOutdatedRows = db
    .prepare(`
      SELECT booking_number, check_in, check_out FROM bookings
      WHERE platform = 'booking.com' AND status != 'cancelled'
      AND (guest_name IS NULL OR TRIM(guest_name) = '')
      AND check_out < ?
    `)
    .all(today);

  console.log(`About to delete ${missingDatesRows.length} Airbnb booking(s) with missing dates:`);
  missingDatesRows.forEach((r) => console.log(`  ${r.booking_number} (${r.guest_name || 'no name'})`));

  console.log(`\nAbout to delete ${missingNameOutdatedRows.length} outdated Booking.com booking(s) with missing guest name:`);
  missingNameOutdatedRows.forEach((r) => console.log(`  ${r.booking_number} (${r.check_in} to ${r.check_out})`));

  const delMissingDates = db.prepare(`
    DELETE FROM bookings WHERE platform = 'airbnb' AND status != 'cancelled'
    AND (check_in IS NULL OR check_out IS NULL)
  `);
  const delOutdatedNames = db.prepare(`
    DELETE FROM bookings WHERE platform = 'booking.com' AND status != 'cancelled'
    AND (guest_name IS NULL OR TRIM(guest_name) = '') AND check_out < ?
  `);

  const r1 = delMissingDates.run();
  const r2 = delOutdatedNames.run(today);

  console.log(`\nDeleted ${r1.changes} Airbnb row(s) with missing dates.`);
  console.log(`Deleted ${r2.changes} outdated Booking.com row(s) with missing name.`);

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

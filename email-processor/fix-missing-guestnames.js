// Re-scrapes the Booking.com bookings that are still missing a guest name and
// still upcoming (already-checked-out ones were handled by cleanup-historical-issues.js
// instead). Requires scraper-service.js to be running with the Unicode-aware
// guest-name regex fix already deployed, and the Chrome login session to be fresh.
//
// Safe to re-run - skips any booking that already has a guest name.
const lib = require('./lib');

const BOOKING_NUMBERS = ['5397657258', '6099334262', '6525698158'];

async function main() {
  const db = lib.openDb();

  for (const bookingNumber of BOOKING_NUMBERS) {
    const before = db.prepare('SELECT booking_number, guest_name, status FROM bookings WHERE booking_number = ?').get(bookingNumber);

    if (!before) {
      console.log(`${bookingNumber}: not found in database - skipping.`);
      continue;
    }
    if (before.guest_name && before.guest_name.trim()) {
      console.log(`${bookingNumber}: already has a name ("${before.guest_name}") - skipping.`);
      continue;
    }

    console.log(`${bookingNumber}: scraping...`);
    await lib.sleep(lib.randomDelayMs()); // same pacing as normal Sync Now, to avoid tripping Booking.com's block detection

    const bookingLink = lib.buildBookingLink(bookingNumber);
    let result;
    try {
      result = await lib.scrape(bookingLink);
    } catch (err) {
      console.log(`${bookingNumber}: scrape request error - ${err.message}`);
      continue;
    }

    if (result.status === 'BLOCKED' || result.status === 'LOGIN_REQUIRED') {
      console.log(`${bookingNumber}: ${result.status} - ${result.message}. Stopping here - check the Chrome login session before retrying.`);
      break;
    }
    if (result.status !== 'OK') {
      console.log(`${bookingNumber}: unexpected scrape result - ${JSON.stringify(result)}`);
      continue;
    }

    lib.saveBooking(db, bookingNumber, before.status, result);
    const after = db.prepare('SELECT booking_number, guest_name FROM bookings WHERE booking_number = ?').get(bookingNumber);
    console.log(`${bookingNumber}: done - guest name is now "${after.guest_name}"`);
  }

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

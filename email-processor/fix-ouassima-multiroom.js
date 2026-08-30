// One-off correction for booking 5827500092 (Ouassima Bouali), currently mis-saved
// as a single "Normal Room" booking - the Double Bedroom room was silently dropped
// by the old scraper. Re-scrapes with the fixed multi-room-aware scraper-service.js
// and splits it into two proper rows. Run this AFTER deploying the updated
// lib.js and scraper-service.js (needs scraper-service running + Chrome logged in).
const lib = require('./lib');

const BOOKING_NUMBER = '5827500092';

async function main() {
  const db = lib.openDb();

  const before = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(BOOKING_NUMBER);
  console.log('Before:', before);

  const bookingLink = lib.buildBookingLink(BOOKING_NUMBER);
  const result = await lib.scrape(bookingLink);

  if (result.status !== 'OK') {
    console.log(`Scrape did not succeed - status: ${result.status}, message: ${result.message || ''}`);
    db.close();
    return;
  }

  if (!result.multiRoom) {
    console.log('Scrape came back single-room - either already fixed, or something changed. Not touching the DB.');
    console.log(result);
    db.close();
    return;
  }

  lib.saveMultiRoomBooking(db, BOOKING_NUMBER, before ? before.status : 'new', result);

  console.log('After:');
  console.log(db.prepare('SELECT booking_number, room_category, guest_name, check_in, check_out, status FROM bookings WHERE booking_number = ?').get(`${BOOKING_NUMBER}-1`));
  console.log(db.prepare('SELECT booking_number, room_category, guest_name, check_in, check_out, status FROM bookings WHERE booking_number = ?').get(`${BOOKING_NUMBER}-2`));
  console.log('Fixed. Both rooms now need a physical room assigned via the dashboard dropdown, same as any other booking.');

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

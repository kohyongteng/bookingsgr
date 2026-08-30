// check-booking-sf260807.js
//
// Prints the raw, current DB row for one booking, so we can see exactly
// what's actually stored (vs. guessing from the dashboard UI or an old
// alert email).
//
// Usage (on the mini PC):
//   node check-booking-sf260807.js

const Database = require('better-sqlite3');

const DB_PATH = 'C:\\apps\\shared-data\\bookings.db';

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare("SELECT * FROM bookings WHERE booking_number LIKE 'SF260807%'").all();

if (rows.length === 0) {
  console.log('No bookings found matching "SF260807%" - both rows are gone.');
} else {
  console.log(`Found ${rows.length} matching row(s):\n`);
  rows.forEach((row) => {
    console.log(JSON.stringify(row, null, 2));
    console.log('---');
  });
}

db.close();

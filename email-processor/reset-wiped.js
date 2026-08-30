const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const stmt = db.prepare("UPDATE bookings SET room_category = NULL WHERE booking_number IN ('6846640975', '6992350800', '6153626303')");
const result = stmt.run();
console.log(`Reset ${result.changes} rows for re-scraping.`);

const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const row = db.prepare("SELECT * FROM bookings WHERE booking_number = '6909058009'").get();
console.log(row || 'NOT FOUND in database');

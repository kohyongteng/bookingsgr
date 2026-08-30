const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const rows = db.prepare("SELECT booking_number, room_category FROM bookings WHERE guest_name IS NULL AND status != 'cancelled'").all();
console.log(rows);

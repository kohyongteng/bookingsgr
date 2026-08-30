const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
console.log(db.prepare("SELECT booking_number, guest_name, room_category, status FROM bookings WHERE room_category IS NULL AND status != 'cancelled'").all());

const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const rows = db.prepare("SELECT booking_number, guest_name, check_in, check_out, status FROM bookings WHERE (check_in IS NULL OR check_out IS NULL) AND status != 'cancelled'").all();
console.log(rows);

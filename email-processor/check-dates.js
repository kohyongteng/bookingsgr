const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const rows = db.prepare("SELECT booking_number, guest_name, check_in, check_out, status FROM bookings WHERE status != 'cancelled' ORDER BY check_in").all();
rows.forEach(r => console.log(r.booking_number, '|', r.guest_name, '|', r.check_in, '->', r.check_out, '|', r.status));

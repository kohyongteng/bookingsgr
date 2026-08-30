const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');

console.log("=== Booking.com rows with check-in around Aug 1-2 ===");
const bk = db.prepare("SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE platform = 'booking.com' AND status != 'cancelled' AND (check_in LIKE '%Aug 1,%' OR check_in LIKE '%Aug 2,%')").all();
bk.forEach(r => console.log(JSON.stringify(r)));

console.log("\n=== Airbnb rows with check-in around Aug 1 ===");
const ab = db.prepare("SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE platform = 'airbnb' AND status != 'cancelled' AND check_in LIKE '2026-08-01%'").all();
ab.forEach(r => console.log(JSON.stringify(r)));

console.log("\n=== ALL Airbnb rows currently overlapping Aug 1 (check_in <= Aug1 AND check_out > Aug1) ===");
const abAll = db.prepare("SELECT booking_number, guest_name, room_number, check_in, check_out FROM bookings WHERE platform = 'airbnb' AND status != 'cancelled' AND check_in <= '2026-08-01' AND check_out > '2026-08-01'").all();
console.log('Count:', abAll.length);
abAll.forEach(r => console.log(JSON.stringify(r)));

const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
console.log(db.prepare("SELECT COUNT(*) as count FROM bookings").get());
console.log(db.prepare("SELECT status, COUNT(*) as count FROM bookings GROUP BY status").all());

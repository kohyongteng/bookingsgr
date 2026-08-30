const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const result = db.prepare("DELETE FROM bookings WHERE room_category = 'UNKNOWN'").run();
console.log(`Deleted ${result.changes} broken rows.`);

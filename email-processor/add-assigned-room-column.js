const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
try {
  db.exec('ALTER TABLE bookings ADD COLUMN assigned_room TEXT');
  console.log('Column added.');
} catch (e) {
  console.log('Already exists or error:', e.message);
}

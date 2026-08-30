const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');
const result = db.prepare('DELETE FROM pending_airbnb_changes').run();
console.log(`Cleared ${result.changes} rows from pending_airbnb_changes (fresh start for re-run).`);

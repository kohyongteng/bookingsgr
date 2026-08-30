const fs = require('fs');
const lib = require('./lib');

const queue = JSON.parse(fs.readFileSync('./pending_bookings.json', 'utf8'));
const db = lib.openDb();

const dbRows = db.prepare('SELECT booking_number, status, room_category, guest_name FROM bookings').all();
const dbByNumber = {};
dbRows.forEach((r) => (dbByNumber[r.booking_number] = r));

console.log('=== RECONCILIATION REPORT ===\n');
console.log(`Gmail queue (pending_bookings.json): ${queue.length} entries`);
console.log(`Database total rows: ${dbRows.length}\n`);

const missingFromDb = [];
const badInDb = [];

for (const q of queue) {
  const dbRow = dbByNumber[q.bookingNumber];
  if (!dbRow) {
    missingFromDb.push(q);
    continue;
  }
  if (q.type !== 'CANCELLED' && (!dbRow.room_category || dbRow.room_category === 'UNKNOWN')) {
    badInDb.push({ ...q, dbStatus: dbRow.status, dbRoomCategory: dbRow.room_category });
  }
}

console.log(`Missing from database entirely: ${missingFromDb.length}`);
missingFromDb.forEach((b) => console.log('  MISSING:', b.bookingNumber, '|', b.type, '|', b.subjectCheckIn));

console.log(`\nIn database but with bad/incomplete data: ${badInDb.length}`);
badInDb.forEach((b) => console.log('  BAD:', b.bookingNumber, '|', b.type, '| db_room_category=', b.dbRoomCategory));

console.log(`\n=== SUMMARY ===`);
console.log(`Total needing attention: ${missingFromDb.length + badInDb.length}`);
console.log(`Correctly saved: ${queue.length - missingFromDb.length - badInDb.length}`);

db.close();

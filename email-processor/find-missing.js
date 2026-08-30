const fs = require('fs');
const lib = require('./lib');

const items = JSON.parse(fs.readFileSync('./pending_bookings.json', 'utf8'));
const db = lib.openDb();

const missing = items.filter((b) => {
  if (b.type === 'CANCELLED') return false;
  return !lib.isAlreadyScraped(db, b.bookingNumber);
});

db.close();

console.log(`Total in queue: ${items.length}`);
console.log(`Already saved (will be skipped): ${items.length - missing.length}`);
console.log(`Still missing (will be scraped): ${missing.length}\n`);

missing.forEach((b) => console.log(b.bookingNumber, '|', b.type, '|', b.subjectCheckIn));

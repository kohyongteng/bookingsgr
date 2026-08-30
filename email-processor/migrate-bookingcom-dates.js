const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toISO(str) {
  if (!str) return null;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/\w+,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return str; // couldn't parse, leave as-is
  const monthIndex = MONTH_NAMES.findIndex((mn) => m[1].startsWith(mn));
  if (monthIndex === -1) return str;
  const y = m[3];
  const mo = String(monthIndex + 1).padStart(2, '0');
  const d = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

const rows = db.prepare("SELECT booking_number, check_in, check_out FROM bookings WHERE platform = 'booking.com'").all();
console.log(`Migrating ${rows.length} Booking.com rows to ISO date format...\n`);

const updateStmt = db.prepare('UPDATE bookings SET check_in = ?, check_out = ? WHERE booking_number = ?');
let converted = 0;
let unchanged = 0;

for (const row of rows) {
  const newCheckIn = toISO(row.check_in);
  const newCheckOut = toISO(row.check_out);
  if (newCheckIn !== row.check_in || newCheckOut !== row.check_out) {
    updateStmt.run(newCheckIn, newCheckOut, row.booking_number);
    console.log(`  ${row.booking_number}: "${row.check_in}" -> "${newCheckIn}"  |  "${row.check_out}" -> "${newCheckOut}"`);
    converted++;
  } else {
    unchanged++;
  }
}

console.log(`\nConverted: ${converted}, Already fine/unchanged: ${unchanged}`);
db.close();

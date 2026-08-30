const db = require('better-sqlite3')('C:\\apps\\shared-data\\bookings.db');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(str) {
  if (!str) return null;
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
  }
  const longMatch = str.match(/\w+,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
  if (longMatch) {
    const monthIndex = MONTH_NAMES.findIndex((m) => longMatch[1].startsWith(m));
    if (monthIndex !== -1) {
      return new Date(parseInt(longMatch[3], 10), monthIndex, parseInt(longMatch[2], 10));
    }
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nightsBetween(checkIn, checkOut) {
  const start = parseDate(checkIn);
  const end = parseDate(checkOut);
  if (!start || !end) return [];
  const nights = [];
  let cur = new Date(start);
  while (cur < end) {
    nights.push(toISODate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return nights;
}

const rows = db.prepare("SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE platform = 'booking.com' AND status != 'cancelled'").all();

console.log(`Checking ${rows.length} total Booking.com rows...\n`);

let matchCount = 0;
rows.forEach(r => {
  const nights = nightsBetween(r.check_in, r.check_out);
  if (nights.includes('2026-08-01')) {
    matchCount++;
    const isCheckinToday = nights[0] === '2026-08-01';
    console.log(`${r.guest_name} | raw check_in="${r.check_in}" check_out="${r.check_out}" | ${isCheckinToday ? 'CHECK-IN TODAY' : 'STAYOVER'}`);
  }
});

console.log(`\nTotal computed for Aug 1: ${matchCount} (you expect 8)`);

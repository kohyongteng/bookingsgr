// Exact copy of the current server.js date logic, tested in isolation
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

// Test cases from the real database
const testCases = [
  { name: 'BK Dmitrii', checkIn: 'Sat, Aug 1, 2026', checkOut: 'Wed, Aug 5, 2026' },
  { name: 'BK Bruno', checkIn: 'Sun, Aug 2, 2026', checkOut: 'Tue, Aug 4, 2026' },
  { name: 'AB Desy', checkIn: '2026-08-01', checkOut: '2026-08-05' },
  { name: 'AB Ngoc', checkIn: '2026-07-31', checkOut: '2026-08-03' },
  { name: 'AB Tim', checkIn: '2026-07-31', checkOut: '2026-08-03' },
];

testCases.forEach(tc => {
  const nights = nightsBetween(tc.checkIn, tc.checkOut);
  console.log(`${tc.name}: checkIn="${tc.checkIn}" checkOut="${tc.checkOut}"`);
  console.log(`  -> nights: [${nights.join(', ')}]`);
  console.log(`  -> includes Aug 1? ${nights.includes('2026-08-01')}`);
  console.log('');
});

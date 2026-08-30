const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOM_MAP_PATH = path.join(__dirname, 'airbnb-ical-map.json');

function getSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  return arg ? arg.split('=')[1] : '2026-07-15';
}

function parseIcsDate(str) {
  const y = str.slice(0, 4);
  const m = str.slice(4, 6);
  const d = str.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function parseIcs(icsText, roomNumber) {
  // iCal spec folds long lines: a newline followed by a single space/tab means
  // "this is a continuation of the previous line, not a new line." Undo that
  // before parsing, otherwise strings like "reservations/details/CODE" can get
  // split mid-word across the fold and silently fail to match.
  const unfolded = icsText.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');

  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    if (summary !== 'Reserved') continue;

    const startMatch = block.match(/DTSTART[^:]*:(\d{8})/);
    const endMatch = block.match(/DTEND[^:]*:(\d{8})/);
    const codeMatch = block.match(/reservations\/details\/([A-Z0-9]+)/);

    if (!startMatch || !endMatch || !codeMatch) continue;

    events.push({
      roomNumber,
      confirmationCode: codeMatch[1],
      checkIn: parseIcsDate(startMatch[1]),
      checkOut: parseIcsDate(endMatch[1]),
    });
  }

  return events;
}

async function main() {
  const sinceDate = new Date(getSinceArg());
  const roomMap = JSON.parse(fs.readFileSync(ROOM_MAP_PATH, 'utf8'));
  const db = lib.openDb();

  const allEvents = [];

  for (const [roomNumber, url] of Object.entries(roomMap)) {
    if (!url) {
      console.log(`Room #${roomNumber}: no iCal URL set, skipping.`);
      continue;
    }

    try {
      const res = await fetch(url);
      const icsText = await res.text();
      const events = parseIcs(icsText, roomNumber);
      console.log(`Room #${roomNumber}: ${events.length} reservation(s) found.`);
      allEvents.push(...events);
    } catch (err) {
      console.error(`Room #${roomNumber}: fetch failed - ${err.message}`);
    }
  }

  const relevant = allEvents.filter((e) => new Date(e.checkIn) >= sinceDate);
  console.log(`\n${relevant.length} reservations across all rooms with check-in >= ${sinceDate.toDateString()}\n`);

  const dbRows = db.prepare("SELECT booking_number FROM bookings WHERE platform = 'airbnb'").all();
  const dbCodes = new Set(dbRows.map((r) => r.booking_number));

  const missing = relevant.filter((e) => !dbCodes.has(e.confirmationCode));

  console.log(`=== RESULT ===`);
  console.log(`In database: ${relevant.length - missing.length}`);
  console.log(`MISSING from database: ${missing.length}\n`);

  missing.forEach((e) => {
    console.log(
      `  Room #${e.roomNumber} | ${e.confirmationCode} | ${e.checkIn} -> ${e.checkOut} | ` +
      `https://www.airbnb.com/hosting/reservations/details/${e.confirmationCode}`
    );
  });

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// STEP 1 - diagnostic only. Does NOT write to the database at all.
//
// For every Airbnb booking currently missing check-in/check-out dates, finds its
// original "Reservation confirmed" email in Gmail and saves the raw body text to
// a log file, so we can see exactly why parseAirbnbNewBooking()'s date regex
// failed to match (e.g. an older/different Airbnb email template) before writing
// any actual fix.
//
// Run: node diagnose-missing-airbnb-dates.js
// Output: airbnb-missing-dates-diagnosis.txt (in this same folder)

const fs = require('fs');
const lib = require('./lib');

async function main() {
  const db = lib.openDb();
  const rows = db
    .prepare(`
      SELECT booking_number, guest_name FROM bookings
      WHERE platform = 'airbnb' AND status != 'cancelled'
      AND (check_in IS NULL OR check_out IS NULL)
      ORDER BY booking_number
    `)
    .all();
  db.close();

  console.log(`Found ${rows.length} Airbnb booking(s) missing check-in/check-out. Searching Gmail for each...`);

  const gmail = lib.getGmailClient('airbnb');
  const outLines = [];
  let found = 0;
  let notFound = 0;

  for (const row of rows) {
    const { booking_number: code, guest_name: guestName } = row;
    outLines.push('='.repeat(80));
    outLines.push(`Booking: ${code}  |  Guest (from DB): ${guestName || '(none)'}`);

    try {
      const q = `subject:"Reservation confirmed" "${code}"`;
      const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
      const messages = list.data.messages || [];

      if (messages.length === 0) {
        outLines.push('  >>> No matching email found in Gmail for this confirmation code.');
        notFound++;
        continue;
      }

      const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
      const headers = full.data.payload.headers;
      const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '(no subject)';
      const { text } = lib.extractBody(full.data.payload);

      outLines.push(`  Subject: ${subject}`);
      outLines.push('  --- Raw body text ---');
      outLines.push(text);
      outLines.push('  --- end body ---');
      found++;
    } catch (err) {
      outLines.push(`  >>> ERROR fetching/searching this one: ${err.message}`);
      notFound++;
    }

    outLines.push('');
  }

  outLines.push('='.repeat(80));
  outLines.push(`SUMMARY: ${found} email(s) found and logged, ${notFound} not found/errored, out of ${rows.length} total.`);

  fs.writeFileSync('./airbnb-missing-dates-diagnosis.txt', outLines.join('\n'), 'utf8');
  console.log(`Done. Found ${found}, not found/errored ${notFound}. See airbnb-missing-dates-diagnosis.txt`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
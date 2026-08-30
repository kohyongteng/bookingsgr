const lib = require('./lib');

function getMonthsArg() {
  const arg = process.argv.find((a) => a.startsWith('--months='));
  const n = arg ? parseInt(arg.split('=')[1], 10) : 6;
  return isNaN(n) ? 6 : n;
}

function getSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  return arg ? arg.split('=')[1] : '2026-07-15';
}

async function main() {
  const months = getMonthsArg();
  const sinceDate = new Date(getSinceArg());
  const gmail = lib.getGmailClient('airbnb');
  const db = lib.openDb();

  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const afterDate = lib.formatGmailDate(d);

  const query = `after:${afterDate} subject:"Reservation confirmed"`;
  console.log(`Querying Gmail (Airbnb): ${query}`);
  console.log(`Only checking bookings with check-in >= ${sinceDate.toDateString()}\n`);

  const messages = await lib.listAllMessages(gmail, query);
  console.log(`Found ${messages.length} "Reservation confirmed" emails in the last ${months} months.\n`);

  const emailBookings = [];
  let fetched = 0;
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.data.payload.headers;
    const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '';
    const receivedDate = full.data.internalDate
      ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
      : null;
    const { text } = lib.extractBody(full.data.payload);

    const parsed = lib.parseAirbnbNewBooking(subject, text, receivedDate);
    if (parsed && parsed.confirmationCode) {
      emailBookings.push(parsed);
    }

    fetched++;
    if (fetched % 50 === 0) {
      console.log(`  ...fetched ${fetched} / ${messages.length}`);
    }
  }

  console.log(`\n${emailBookings.length} successfully parsed from email.\n`);

  const relevantBookings = emailBookings.filter(
    (b) => b.checkIn && new Date(b.checkIn) >= sinceDate
  );
  console.log(`${relevantBookings.length} have check-in on/after the cutoff (relevant).\n`);

  const dbRows = db.prepare("SELECT booking_number FROM bookings WHERE platform = 'airbnb'").all();
  const dbCodes = new Set(dbRows.map((r) => r.booking_number));

  const missing = relevantBookings.filter((b) => !dbCodes.has(b.confirmationCode));

  console.log(`=== RESULT ===`);
  console.log(`In database: ${relevantBookings.length - missing.length}`);
  console.log(`MISSING from database: ${missing.length}\n`);

  missing.forEach((b) =>
    console.log(`  ${b.confirmationCode} | ${b.guestName} | Room ${b.roomNumber} | ${b.checkIn} -> ${b.checkOut}`)
  );

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

const lib = require('./lib');

function getSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  return arg ? arg.split('=')[1] : '2026-07-15';
}

function getMonthsArg() {
  const arg = process.argv.find((a) => a.startsWith('--months='));
  const n = arg ? parseInt(arg.split('=')[1], 10) : 24;
  return isNaN(n) ? 24 : n;
}

async function main() {
  const sinceDate = new Date(getSinceArg());
  const months = getMonthsArg();

  const gmail = lib.getGmailClient('airbnb');
  const db = lib.openDb();

  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const afterDate = lib.formatGmailDate(d);

  const query = `after:${afterDate} (subject:"Reservation confirmed" OR subject:"Canceled: Reservation" OR subject:"wants to change their reservation" OR subject:"Reservation updated")`;
  console.log(`Querying Gmail (Airbnb): ${query}`);
  console.log(`Only keeping bookings with check-in >= ${sinceDate.toDateString()}\n`);

  const messages = await lib.listAllMessages(gmail, query);
  console.log(`Found ${messages.length} matching emails. Fetching full content...`);

  const parsed = [];
  let fetched = 0;
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.data.payload.headers;
    const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '';
    const receivedDate = full.data.internalDate
      ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
      : null;
    const { text } = lib.extractBody(full.data.payload);

    parsed.push({ subject, text, receivedDate });

    fetched++;
    if (fetched % 100 === 0) {
      console.log(`  ...fetched ${fetched} / ${messages.length}`);
    }
  }

  parsed.sort((a, b) => new Date(a.receivedDate) - new Date(b.receivedDate));

  let newCount = 0;
  let newSkippedPastCheckIn = 0;
  let cancelledCount = 0;
  let changeQueuedCount = 0;
  let changeIgnoredCount = 0;
  let updateAppliedCount = 0;
  let updateNoMatchCount = 0;

  for (const item of parsed) {
    const { subject, text, receivedDate } = item;

    if (subject.startsWith('Reservation confirmed')) {
      const result = lib.parseAirbnbNewBooking(subject, text, receivedDate);
      if (result && result.confirmationCode) {
        if (result.checkIn && new Date(result.checkIn) < sinceDate) {
          newSkippedPastCheckIn++;
          continue;
        }
        lib.saveAirbnbBooking(db, result);
        newCount++;
      }
      continue;
    }

    if (subject.startsWith('Canceled: Reservation')) {
      const result = lib.parseAirbnbCancellation(subject);
      if (result) {
        lib.saveAirbnbCancellation(db, result.confirmationCode);
        cancelledCount++;
      }
      continue;
    }

    if (subject.includes('wants to change their reservation')) {
      const result = lib.parseAirbnbChangeRequest(subject, text, receivedDate);
      if (result && result.type === 'CHANGE_REQUEST_DATES') {
        if (!result.roomNumber) {
          console.log(`  WARNING: could not extract room number for change request "${subject}" - skipping queue, needs manual check.`);
          changeIgnoredCount++;
        } else {
          lib.queueAirbnbChangeRequest(db, result);
          changeQueuedCount++;
        }
      } else {
        changeIgnoredCount++;
      }
      continue;
    }

    if (subject === 'Reservation updated') {
      const result = lib.parseAirbnbUpdateConfirmed(text);
      if (result) {
        const applyResult = lib.applyAirbnbUpdate(db, result);
        if (applyResult.applied) updateAppliedCount++;
        else updateNoMatchCount++;
      }
      continue;
    }
  }

  db.close();

  console.log(`\n=== BACKFILL SUMMARY ===`);
  console.log(`New bookings saved: ${newCount}`);
  console.log(`New bookings skipped (check-in before cutoff): ${newSkippedPastCheckIn}`);
  console.log(`Cancellations applied: ${cancelledCount}`);
  console.log(`Date-change requests queued: ${changeQueuedCount}`);
  console.log(`Change requests ignored (guest-count only): ${changeIgnoredCount}`);
  console.log(`Update confirmations applied: ${updateAppliedCount}`);
  console.log(`Update confirmations with no match (likely guest-count changes): ${updateNoMatchCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

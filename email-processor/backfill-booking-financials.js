// Backfills financial figures onto existing Booking.com reservations by
// re-scraping the extranet page for each one.
//
// This is the risky counterpart to backfill-financials.js (Airbnb, which reads
// email we already hold). Here every row costs a real page load against
// Booking.com, so:
//   - it paces itself with the same random 8-20s delay the normal sync uses
//   - it STOPS DEAD on the first BLOCKED / LOGIN_REQUIRED signal rather than
//     hammering on and deepening any bot-detection problem
//   - it emails on that stop, so a re-login can happen without watching the log
//   - it only fills rows with no financials yet, so re-running resumes cleanly
//
// Multi-room reservations are stored as "<number>-1", "<number>-2", ... but
// Booking.com prices them as ONE reservation on ONE page - so only the "-1"
// row is scraped and the figures are stored there, never duplicated per room.
//
// Usage:
//   node backfill-booking-financials.js               # dry run
//   node backfill-booking-financials.js --apply
//   node backfill-booking-financials.js --apply --limit=10

process.chdir(__dirname);
require('dotenv').config();
const lib = require('./lib');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fromArg = args.find((a) => a.startsWith('--from='));
const limitArg = args.find((a) => a.startsWith('--limit='));
const FROM_DATE = fromArg ? fromArg.split('=')[1] : '2026-09-01';
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const ADMIN_EMAIL = 'teng20240301@gmail.com';

function ts() {
  return new Date().toISOString();
}

async function alertStopped(reason, detail, done, total) {
  try {
    const gmail = lib.getGmailClient();
    await lib.sendAlertEmail(
      gmail,
      ADMIN_EMAIL,
      `Booking.com financial backfill stopped: ${reason}`,
      `The financial backfill stopped after ${done} of ${total} reservation(s).\n\n` +
      `Reason: ${reason}\n${detail}\n\n` +
      `Please log in to the Chrome window on the mini PC (via AnyDesk), then re-run:\n` +
      `  cd C:\\apps\\email-processor\n` +
      `  node backfill-booking-financials.js --apply\n\n` +
      `It resumes automatically - already-filled reservations are skipped.`
    );
    console.log(`[${ts()}] Alert email sent to ${ADMIN_EMAIL}.`);
  } catch (err) {
    console.error(`[${ts()}] FAILED to send alert email: ${err.message}`);
  }
}

(async () => {
  const db = lib.openDb();

  // Only "-1" or plain numbers: a "-2"/"-3" sub-row is the same physical
  // reservation and the same page, so scraping it again would be a wasted
  // (and detectable) duplicate request.
  const rows = db.prepare(`
    SELECT booking_number, guest_name, check_in, check_out
    FROM bookings
    WHERE platform = 'booking.com' AND check_out >= ? AND status != 'cancelled'
      AND gross_amount IS NULL
      AND (booking_number NOT LIKE '%-%' OR booking_number LIKE '%-1')
    ORDER BY check_out
  `).all(FROM_DATE);

  const targets = rows.slice(0, LIMIT);
  console.log(`[${ts()}] ${APPLY ? 'APPLY' : 'DRY RUN'} - ${targets.length} Booking.com reservation(s) to scrape (from ${FROM_DATE})`);
  if (!APPLY) console.log('(dry run: pages WILL still be fetched, but nothing is written)');

  let done = 0, saved = 0, noFinancials = 0, errors = 0;
  const totals = { gross: 0, tax: 0, fee: 0, net: 0 };

  for (const b of targets) {
    const baseNumber = b.booking_number.replace(/-\d+$/, '');
    await lib.sleep(lib.randomDelayMs());

    let result;
    try {
      result = await lib.scrape(lib.buildBookingLink(baseNumber));
    } catch (err) {
      errors++;
      console.error(`[${ts()}] [error]  ${b.booking_number}: ${err.message}`);
      continue;
    }

    if (result.status === 'BLOCKED' || result.status === 'LOGIN_REQUIRED') {
      console.error(`[${ts()}] STOPPING - ${result.status}: ${result.message || ''}`);
      await alertStopped(result.status, result.message || '', done, targets.length);
      break;
    }

    if (result.status !== 'OK') {
      errors++;
      console.error(
        `[${ts()}] [error]  ${b.booking_number}: status=${result.status} ${result.message || JSON.stringify(result).slice(0, 200)}`
      );
      continue;
    }

    done++;
    if (!result.financials || result.financials.grossAmount == null) {
      noFinancials++;
      console.log(`[${ts()}] [no data] ${b.booking_number}  ${b.guest_name}`);
      continue;
    }

    const f = result.financials;
    totals.gross += f.grossAmount || 0;
    totals.tax += f.taxAmount || 0;
    totals.fee += f.platformFee || 0;
    totals.net += f.netPayout || 0;

    if (APPLY && lib.saveFinancials(db, b.booking_number, f, 'booking-scrape')) saved++;
    console.log(
      `[${ts()}] [ok]      ${b.booking_number}  gross=${f.grossAmount} tax=${f.taxAmount} fee=${f.platformFee} net=${f.netPayout}`
    );
  }

  console.log('\n--- summary ---');
  console.log(`scraped OK      : ${done}`);
  console.log(`no money block  : ${noFinancials}`);
  console.log(`errors          : ${errors}`);
  if (APPLY) console.log(`rows written    : ${saved}`);
  console.log(
    `totals: gross=RM${totals.gross.toFixed(2)} tax=RM${totals.tax.toFixed(2)} ` +
    `fee=RM${totals.fee.toFixed(2)} net=RM${totals.net.toFixed(2)}`
  );

  db.close();
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

// One-off/repeatable backfill: fills the financial columns on existing Airbnb
// bookings from the "Reservation confirmed" host emails already in Gmail.
//
// Quota note: this searches Gmail once per booking (targeted `code` search)
// rather than bulk-fetching every confirmation email in a date range. For ~130
// bookings that is roughly 10x cheaper, and it is paced with a small delay so
// it never bursts alongside detector.js's own 5-minute Gmail cycles - the
// pattern that exhausted the per-minute quota previously.
//
// Safe to re-run: only fills rows that don't already have financials, unless
// --force is passed. Never creates or deletes booking rows.
//
// Usage:
//   node backfill-financials.js                 # dry run, reports only
//   node backfill-financials.js --apply         # writes to the database
//   node backfill-financials.js --apply --from=2026-09-01 --force

process.chdir(__dirname);
require('dotenv').config();
const lib = require('./lib');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const fromArg = args.find((a) => a.startsWith('--from='));
const FROM_DATE = fromArg ? fromArg.split('=')[1] : '2026-09-01';
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const db = lib.openDb();

  const where = FORCE
    ? "platform = 'airbnb' AND check_out >= ? AND status != 'cancelled'"
    : "platform = 'airbnb' AND check_out >= ? AND status != 'cancelled' AND gross_amount IS NULL";
  const bookings = db.prepare(
    `SELECT booking_number, guest_name, check_in, check_out FROM bookings WHERE ${where} ORDER BY check_out`
  ).all(FROM_DATE);

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} - ${bookings.length} Airbnb booking(s) from ${FROM_DATE} needing financials\n`);

  let matched = 0;
  let notFound = 0;
  let unparseable = 0;
  let written = 0;
  const totals = { gross: 0, tax: 0, fee: 0, net: 0 };

  for (const b of bookings) {
    await sleep(DELAY_MS);
    const code = b.booking_number;
    try {
      const msgs = await lib.listAllMessages(gmail, `subject:"Reservation confirmed" "${code}"`);
      if (!msgs.length) {
        notFound++;
        console.log(`[no email]   ${code}  ${b.guest_name}`);
        continue;
      }

      // Newest first from Gmail; the most recent confirmation wins if a
      // reservation was altered and re-confirmed.
      const full = await gmail.users.messages.get({ userId: 'me', id: msgs[0].id, format: 'full' });
      const { text } = lib.extractBody(full.data.payload);
      const f = lib.parseAirbnbFinancials(text);

      if (!f) {
        unparseable++;
        console.log(`[unparsed]   ${code}  ${b.guest_name}`);
        continue;
      }
      if (f.confirmationCode !== code) {
        // The search hit an email for a different reservation that merely
        // mentioned this code - don't write someone else's money to this row.
        notFound++;
        console.log(`[code mismatch] ${code} != ${f.confirmationCode} - skipped`);
        continue;
      }

      matched++;
      totals.gross += f.grossAmount || 0;
      totals.tax += f.taxAmount || 0;
      totals.fee += f.platformFee || 0;
      totals.net += f.netPayout || 0;

      if (APPLY) {
        if (lib.saveFinancials(db, code, f, 'airbnb-email')) written++;
      }
      console.log(
        `[ok]         ${code}  gross=${f.grossAmount} tax=${f.taxAmount ?? 0} fee=${f.platformFee} net=${f.netPayout}`
      );
    } catch (err) {
      console.error(`[error]      ${code}: ${err.message}`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`matched/parsed : ${matched}`);
  console.log(`no email found : ${notFound}`);
  console.log(`unparseable    : ${unparseable}`);
  if (APPLY) console.log(`rows written   : ${written}`);
  console.log(
    `\ntotals across matched: gross=RM${totals.gross.toFixed(2)} tax=RM${totals.tax.toFixed(2)} ` +
    `platformFee=RM${totals.fee.toFixed(2)} net=RM${totals.net.toFixed(2)}`
  );
  if (!APPLY) console.log('\n(dry run - nothing written. Re-run with --apply to save.)');

  db.close();
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

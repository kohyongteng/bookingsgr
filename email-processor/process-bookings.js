const fs = require('fs');
const lib = require('./lib');

const INPUT_PATH = './pending_bookings.json';
const BLOCKED_FLAG_PATH = './blocked.flag';
const ADMIN_EMAIL = 'teng20240301@gmail.com'; // change if needed

async function main() {
  if (fs.existsSync(BLOCKED_FLAG_PATH)) {
    console.log(
      `blocked.flag present — refusing to run. Log back into the Chrome window on the mini PC, ` +
      `then delete blocked.flag to resume.`
    );
    return;
  }

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`${INPUT_PATH} not found. Run "node fetch-emails.js" first.`);
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  console.log(`Loaded ${items.length} entries from ${INPUT_PATH}`);

  const gmail = lib.getGmailClient();
  const db = lib.openDb();

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const b of items) {
    if (b.type === 'CANCELLED') {
      lib.saveCancelled(db, b);
      processed++;
      console.log(`Cancelled: ${b.bookingNumber} (${b.guestName || 'unknown guest'})`);
      continue;
    }

    if (lib.isAlreadyScraped(db, b.bookingNumber)) {
      skipped++;
      continue;
    }

    console.log(`Waiting before scraping ${b.bookingNumber}...`);
    await lib.sleep(lib.randomDelayMs());

    let result;
    try {
      result = await lib.scrape(b.bookingLink);
    } catch (err) {
      console.error(`Scrape request failed for ${b.bookingNumber}: ${err.message}`);
      failed++;
      continue;
    }

    if (result.status === 'BLOCKED' || result.status === 'LOGIN_REQUIRED') {
      console.error(`STOPPING: ${result.status} — ${result.message}`);
      fs.writeFileSync(BLOCKED_FLAG_PATH, new Date().toISOString());
      try {
        await lib.sendAlertEmail(
          gmail,
          ADMIN_EMAIL,
          `Booking.com processor stopped: ${result.status}`,
          `${result.message}\n\nStopped at booking ${b.bookingNumber}.\n` +
          `Please log in to the Chrome window on the mini PC, then delete blocked.flag in the email-processor folder to resume.`
        );
        console.log('Alert email sent.');
      } catch (err) {
        console.error('Failed to send alert email:', err.message);
      }
      db.close();
      process.exit(1);
    }

    if (result.status !== 'OK') {
      console.error(`Scrape failed for ${b.bookingNumber}: ${JSON.stringify(result)}`);
      failed++;
      continue;
    }

    const status = b.type === 'MODIFIED' ? 'modified' : 'new';
    lib.saveBooking(db, b.bookingNumber, status, result);
    processed++;
    console.log(`Saved ${b.bookingNumber} — ${result.guestName} (${result.roomType})`);
  }

  db.close();
  console.log(
    `\n[${new Date().toISOString()}] Done. Processed: ${processed}, Skipped (already saved): ${skipped}, Failed: ${failed}`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

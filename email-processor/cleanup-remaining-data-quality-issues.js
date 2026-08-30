// Deletes every remaining data-quality issue that the 6-hourly alert would
// already consider "not relevant" (checked out before today, and not recently
// touched) - i.e. exactly the historical junk that keeps triggering reminders
// for stuff nobody's going to fix. Uses the SAME relevance test as the alert
// itself, so nothing that's actually still current ever gets deleted.
const lib = require('./lib');

async function main() {
  const db = lib.openDb();
  const now = new Date();
  const today = lib.toLocalISODate(now);
  const recentCutoff = new Date(now);
  recentCutoff.setDate(recentCutoff.getDate() - 7);

  const allIssues = lib.checkDataQuality(db);

  const toDelete = allIssues.filter((i) => {
    // Same logic as the alert filter in detector.js: trust an actual check-out
    // date over recency (a bulk backfill can make old rows look "recently
    // touched" for days without anything about them actually being new).
    const stillRelevant = i.checkOut
      ? i.checkOut >= today
      : i.updatedAt && new Date(i.updatedAt) >= recentCutoff;
    return !stillRelevant;
  });
  const staying = allIssues.length - toDelete.length;

  console.log(`Found ${allIssues.length} total data-quality issue(s).`);
  console.log(`${toDelete.length} are historical/not relevant and will be deleted:`);
  toDelete.forEach((i) => console.log(`  ${i.bookingNumber} (${i.platform}) - ${i.problems.join('; ')}`));

  const del = db.prepare('DELETE FROM bookings WHERE booking_number = ?');
  let count = 0;
  for (const i of toDelete) {
    del.run(i.bookingNumber);
    count++;
  }

  console.log(`\nDeleted ${count} row(s).`);
  console.log(`${staying} still-current/recent issue(s) left untouched - check the dashboard for those.`);

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

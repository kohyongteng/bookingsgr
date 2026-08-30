const lib = require('./lib');

function getSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  return arg ? arg.split('=')[1] : '2026-07-15';
}

async function main() {
  const sinceDate = new Date(getSinceArg());
  console.log(`Cleaning up Airbnb bookings with check-in before ${sinceDate.toDateString()}\n`);

  const db = lib.openDb();

  const outdated = db
    .prepare(`SELECT booking_number, guest_name, check_in FROM bookings WHERE platform = 'airbnb' AND check_in < ?`)
    .all(sinceDate.toISOString().slice(0, 10));

  console.log(`Found ${outdated.length} outdated Airbnb bookings:\n`);
  outdated.forEach((b) => console.log(`  ${b.booking_number} | ${b.guest_name} | check-in: ${b.check_in}`));

  if (outdated.length > 0) {
    const stmt = db.prepare(`DELETE FROM bookings WHERE platform = 'airbnb' AND check_in < ?`);
    const result = stmt.run(sinceDate.toISOString().slice(0, 10));
    console.log(`\nDeleted ${result.changes} outdated rows.`);
  } else {
    console.log('\nNothing to clean up.');
  }

  const staleChanges = db
    .prepare(`SELECT COUNT(*) as count FROM pending_airbnb_changes WHERE requested_check_in < ?`)
    .get(sinceDate.toISOString().slice(0, 10));

  if (staleChanges.count > 0) {
    db.prepare(`DELETE FROM pending_airbnb_changes WHERE requested_check_in < ?`).run(
      sinceDate.toISOString().slice(0, 10)
    );
    console.log(`Also deleted ${staleChanges.count} stale pending change requests (before cutoff).`);
  }

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

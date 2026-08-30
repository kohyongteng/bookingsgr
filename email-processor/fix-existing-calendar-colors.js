const lib = require('./lib');

async function main() {
  const db = lib.openDb();
  const calendar = lib.getCalendarClient('airbnb');

  const trackedEvents = db
    .prepare("SELECT * FROM calendar_sync WHERE booking_number != '__SUMMARY__'")
    .all();

  console.log(`Found ${trackedEvents.length} tracked booking events to check.\n`);

  let fixed = 0;
  let alreadyCorrect = 0;
  let skippedNoBooking = 0;

  for (const event of trackedEvents) {
    const booking = db
      .prepare('SELECT platform FROM bookings WHERE booking_number = ?')
      .get(event.booking_number);

    if (!booking) {
      skippedNoBooking++;
      continue;
    }

    const correctColor = lib.buildEventColor(booking);

    if (event.last_color === correctColor) {
      alreadyCorrect++;
      continue;
    }

    try {
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: event.event_id,
        requestBody: { colorId: correctColor },
      });
      db.prepare('UPDATE calendar_sync SET last_color = ? WHERE booking_number = ? AND night_date = ?').run(
        correctColor,
        event.booking_number,
        event.night_date
      );
      fixed++;
      if (fixed % 25 === 0) console.log(`  ...fixed ${fixed} so far`);
    } catch (err) {
      console.log(`  Failed to update ${event.booking_number} / ${event.night_date}: ${err.message}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Skipped (booking no longer exists): ${skippedNoBooking}`);

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

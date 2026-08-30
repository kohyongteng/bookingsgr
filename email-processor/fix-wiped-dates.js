const lib = require('./lib');

const bookingNumbers = ['6846640975', '6992350800', '6153626303'];

(async () => {
  const db = lib.openDb();
  for (const num of bookingNumbers) {
    console.log(`Waiting before scraping ${num}...`);
    await lib.sleep(lib.randomDelayMs());
    const link = lib.buildBookingLink(num);
    const result = await lib.scrape(link);
    if (result.status === 'OK') {
      lib.saveBooking(db, num, 'new', result);
      console.log(`Fixed ${num} — ${result.guestName} (${result.roomType})`);
    } else {
      console.log(`Failed ${num}:`, result);
    }
  }
  db.close();
})();

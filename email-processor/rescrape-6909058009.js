const lib = require('./lib');

(async () => {
  const db = lib.openDb();
  const link = lib.buildBookingLink('6909058009');
  console.log('Re-scraping:', link);
  const result = await lib.scrape(link);
  console.log(result);
  if (result.status === 'OK') {
    lib.saveBooking(db, '6909058009', 'modified', result);
    console.log('Updated with fresh data.');
  }
  db.close();
})();

const lib = require('./lib');

(async () => {
  const db = lib.openDb();
  const link = lib.buildBookingLink('5331584070');
  const result = await lib.scrape(link);
  console.log(result);
  if (result.status === 'OK') {
    lib.saveBooking(db, '5331584070', 'new', result);
    console.log('Saved successfully.');
  }
  db.close();
})();

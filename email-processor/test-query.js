const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();

  // Get the exact message ID for this booking
  const targeted = await lib.listAllMessages(gmail, 'from:booking.com 5711919920');
  const targetId = targeted[0].id;
  console.log('Target message ID:', targetId);

  // Now run the EXACT query fetch-emails.js uses
  const d = new Date();
  d.setMonth(d.getMonth() - 24);
  const afterDate = lib.formatGmailDate(d);
  const query = `from:booking.com subject:"booking!" after:${afterDate}`;
  console.log('Testing query:', query);

  const results = await lib.listAllMessages(gmail, query);
  console.log('Total results from this query:', results.length);

  const found = results.some(m => m.id === targetId);
  console.log('Is target message in these results?', found);
})();

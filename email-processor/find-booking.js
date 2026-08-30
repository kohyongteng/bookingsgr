const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();
  const messages = await lib.listAllMessages(gmail, 'from:booking.com 5711919920');
  console.log('Found', messages.length, 'emails mentioning this booking number');
  for (const m of messages) {
    const meta = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'Date'] });
    const subj = meta.data.payload.headers.find(h => h.name === 'Subject');
    const date = meta.data.payload.headers.find(h => h.name === 'Date');
    console.log('---');
    console.log('Subject:', subj ? subj.value : '(none)');
    console.log('Date:', date ? date.value : '(none)');
  }
})();

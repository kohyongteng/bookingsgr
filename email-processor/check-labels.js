const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();
  const messages = await lib.listAllMessages(gmail, 'from:booking.com 5711919920');
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata' });
    console.log('Labels:', full.data.labelIds);
  }
})();

const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();
  const targetId = '19bf4492ce22d213';

  const meta = await gmail.users.messages.get({
    userId: 'me',
    id: targetId,
    format: 'metadata',
    metadataHeaders: ['Subject'],
  });

  const cutoffDate = new Date('2026-07-15');
  const result = lib.parseSubjectOnly(meta.data, cutoffDate);

  console.log('Raw subject header:', meta.data.payload.headers.find(h => h.name === 'Subject').value);
  console.log('parseSubjectOnly result:', result);
})();

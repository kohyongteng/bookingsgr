const lib = require('./lib');

const subjects = [
  'Abdul Malik wants to change their reservation',
  'Faraz wants to change their reservation',
  'David wants to change their reservation',
];

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const db = lib.openDb();

  for (const subj of subjects) {
    const messages = await lib.listAllMessages(gmail, `subject:"${subj}"`);
    if (messages.length === 0) {
      console.log(`Not found: ${subj}`);
      continue;
    }
    const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
    const headers = full.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject').value;
    const receivedDate = new Date(parseInt(full.data.internalDate, 10)).toISOString();
    const { text } = lib.extractBody(full.data.payload);

    const result = lib.parseAirbnbChangeRequest(subject, text, receivedDate);
    console.log(subject, '->', result);

    if (result && result.type === 'CHANGE_REQUEST_DATES' && result.roomNumber) {
      lib.queueAirbnbChangeRequest(db, result);
      console.log('  Queued successfully.');
    } else {
      console.log('  Still could not process - needs manual review.');
    }
  }

  db.close();
})();

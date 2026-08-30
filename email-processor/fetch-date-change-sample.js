const lib = require('./lib');
const fs = require('fs');

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const messages = await lib.listAllMessages(gmail, 'subject:"wants to change their reservation" "Requested Dates"');
  console.log(`Found ${messages.length} date-change emails.`);
  if (messages.length === 0) {
    console.log('None found with this exact search - trying broader search...');
    return;
  }
  const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
  const headers = full.data.payload.headers;
  const subject = headers.find(h => h.name === 'Subject');
  const { text } = lib.extractBody(full.data.payload);
  fs.writeFileSync('./sample-change-request-dates.txt', `SUBJECT: ${subject.value}\n\n${text}`);
  console.log('Saved sample-change-request-dates.txt');
})();

const lib = require('./lib');
const fs = require('fs');

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const messages = await lib.listAllMessages(gmail, 'subject:"Abdul Malik wants to change their reservation"');
  if (messages.length === 0) {
    console.log('Not found.');
    return;
  }
  const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
  const { text } = lib.extractBody(full.data.payload);
  fs.writeFileSync('./sample-missing-room.txt', text);
  console.log('Saved sample-missing-room.txt');
  console.log(text);
})();

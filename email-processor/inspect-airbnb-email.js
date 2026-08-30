const lib = require('./lib');
const fs = require('fs');

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const messages = await lib.listAllMessages(gmail, 'subject:"Reservation confirmed"');
  console.log(`Found ${messages.length} matching emails.`);

  if (messages.length === 0) {
    console.log('No matches - try a broader search.');
    return;
  }

  const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
  const headers = full.data.payload.headers;
  const subject = headers.find(h => h.name === 'Subject');
  console.log('Subject:', subject ? subject.value : '(none)');

  const { html, text } = lib.extractBody(full.data.payload);

  fs.writeFileSync('./debug-airbnb-body.html', html);
  fs.writeFileSync('./debug-airbnb-body.txt', text);
  console.log('Saved debug-airbnb-body.html and debug-airbnb-body.txt');
  console.log('HTML length:', html.length, '| Text length:', text.length);

  const idx = text.indexOf('Confirmation code');
  if (idx > -1) {
    console.log('\n--- Context around "Confirmation code" (plain text) ---');
    console.log(text.slice(idx, idx + 150));
  } else {
    console.log('\n"Confirmation code" not found in plain text version.');
  }
})();
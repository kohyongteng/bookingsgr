const lib = require('./lib');
const fs = require('fs');

async function saveSample(gmail, query, label) {
  const messages = await lib.listAllMessages(gmail, query);
  console.log(`${label}: found ${messages.length} matching emails.`);
  if (messages.length === 0) {
    console.log(`  No sample available for ${label}.`);
    return;
  }
  const full = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'full' });
  const headers = full.data.payload.headers;
  const subject = headers.find(h => h.name === 'Subject');
  const dateHeader = headers.find(h => h.name === 'Date');
  const { text } = lib.extractBody(full.data.payload);

  fs.writeFileSync(`./sample-${label}.txt`, `SUBJECT: ${subject ? subject.value : '(none)'}\nDATE: ${dateHeader ? dateHeader.value : '(none)'}\n\n${text}`);
  console.log(`  Saved sample-${label}.txt (subject: "${subject ? subject.value : '(none)'}")`);
}

(async () => {
  const gmail = lib.getGmailClient('airbnb');

  await saveSample(gmail, 'subject:"Canceled: Reservation"', 'cancelled');
  await saveSample(gmail, 'subject:"wants to change their reservation"', 'change-request');
  await saveSample(gmail, 'subject:"Reservation updated"', 'update-confirmed');
})();

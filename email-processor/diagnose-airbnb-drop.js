// diagnose-airbnb-drop.js
//
// Pulls one specific Airbnb "Reservation confirmed" email and runs it
// through the real extractBody() + parseAirbnbNewBooking() from lib.js,
// printing exactly what the parser sees at each step — so we can see
// precisely where/why it silently failed instead of guessing.
//
// Place this in C:\Users\scada\email-processor\ (next to lib.js) and run:
//   node diagnose-airbnb-drop.js
//
// Edit SEARCH_QUERY below if you want to target a different booking later.

const lib = require('./lib.js');

// Narrow, specific search for this one email. Adjust the guest name/date
// here to diagnose a different dropped booking in future.
const SEARCH_QUERY = 'subject:"Reservation confirmed" "Aug 17" from:airbnb';

async function main() {
  const gmail = lib.getGmailClient('airbnb');

  const messages = await lib.listAllMessages(gmail, SEARCH_QUERY);
  if (messages.length === 0) {
    console.log(`No messages found for query: ${SEARCH_QUERY}`);
    console.log('Try loosening the search (e.g. just the date, or just from:airbnb).');
    return;
  }

  console.log(`Found ${messages.length} matching message(s). Examining each:\n`);

  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.data.payload.headers;
    const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '';
    const receivedDate = full.data.internalDate
      ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
      : new Date().toISOString();

    console.log('='.repeat(70));
    console.log(`Subject : ${subject}`);
    console.log(`Received: ${receivedDate}`);
    console.log(`Msg ID  : ${m.id}`);

    // Step 1: does the subject regex match at all?
    const subjectMatch = subject.match(/^Reservation confirmed - (.+) arrives (\w+ \d+)$/);
    console.log(`\nSubject regex match: ${subjectMatch ? 'YES' : 'NO'}`);
    if (subjectMatch) {
      console.log(`  guestName captured : "${subjectMatch[1]}"`);
      console.log(`  date captured       : "${subjectMatch[2]}"`);
    }

    // Step 2: extract the body text exactly as the real parser does.
    const { text } = lib.extractBody(full.data.payload);

    // Step 3: show the exact slice of text around "Confirmation code",
    // with visible whitespace, so we can see newline vs space vs order issues.
    const idx = text.search(/confirmation code/i);
    console.log('\n--- Raw text around "Confirmation code" (whitespace shown as symbols) ---');
    if (idx === -1) {
      console.log('"Confirmation code" not found in extracted text AT ALL.');
      console.log('First 500 chars of extracted body, for reference:');
      console.log(JSON.stringify(text.slice(0, 500)));
    } else {
      const snippet = text.slice(idx, idx + 150);
      console.log(JSON.stringify(snippet)); // JSON.stringify shows \n, \t explicitly
    }

    // Step 4: run the actual two regexes the real code uses, in order.
    const codeMatch =
      text.match(/CONFIRMATION CODE\s*\n(\S+)/i) || text.match(/reservations\/details\/([A-Z0-9]+)/);
    console.log(`\nconfirmationCode regex match: ${codeMatch ? `YES -> "${codeMatch[1]}"` : 'NO MATCH'}`);

    // Step 5: run the whole real parser function and show its full output.
    const parsed = lib.parseAirbnbNewBooking(subject, text, receivedDate);
    console.log('\nFull parseAirbnbNewBooking() result:');
    console.log(parsed);

    if (parsed && !parsed.confirmationCode) {
      console.log('\n>>> THIS IS WHY IT WAS DROPPED: subject matched, but confirmationCode came back null.');
      console.log('>>> The booking never reached saveAirbnbBooking() and nothing was logged.');
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});

const lib = require('./lib');

function decodeQuotedPrintable(rawBinaryStr) {
  let str = rawBinaryStr.replace(/=\r\n/g, '').replace(/=\n/g, '');
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '=' && /^[A-Fa-f0-9]{2}$/.test(str.slice(i + 1, i + 3))) {
      bytes.push(parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(str.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

(async () => {
  const gmail = lib.getGmailClient();
  const targetId = '19bf4492ce22d213'; // booking 5711919920

  const full = await gmail.users.messages.get({ userId: 'me', id: targetId, format: 'full' });
  const rawBase64 = full.data.payload.body.data;

  console.log('--- STEP 1: Raw base64url length ---');
  console.log(rawBase64.length);

  const rawBinary = Buffer.from(rawBase64, 'base64url').toString('latin1');
  console.log('\n--- STEP 2: Decoded as latin1, length ---');
  console.log(rawBinary.length);

  // Find where "booking" appears in the RAW (still quoted-printable-encoded) text
  const rawIdx = rawBinary.toLowerCase().indexOf('res=5fid');
  const rawIdx2 = rawBinary.toLowerCase().indexOf('res_id');
  console.log('\n--- STEP 3: Searching raw QP text for "res=5Fid" (QP-encoded underscore) ---');
  console.log('Found at index:', rawIdx);
  console.log('\n--- STEP 3b: Searching raw QP text for literal "res_id" ---');
  console.log('Found at index:', rawIdx2);

  if (rawIdx > -1) {
    console.log('\nContext around match (raw QP text):');
    console.log(rawBinary.slice(rawIdx - 200, rawIdx + 300));
  }

  console.log('\n--- STEP 4: After full quoted-printable decode ---');
  const decoded = decodeQuotedPrintable(rawBinary);
  console.log('Decoded length:', decoded.length);

  const linkMatch = decoded.match(/href="(https:\/\/admin\.booking\.com[^"]+)"/);
  console.log('Link match (double-quote style):', linkMatch ? linkMatch[1] : 'NOT FOUND');

  const anyAdminMention = decoded.indexOf('admin.booking.com');
  console.log('\n"admin.booking.com" appears in decoded text at index:', anyAdminMention);
  if (anyAdminMention > -1) {
    console.log('Context around it (decoded text):');
    console.log(decoded.slice(anyAdminMention - 150, anyAdminMention + 300));
  }
})();

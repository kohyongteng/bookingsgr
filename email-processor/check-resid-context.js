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
  const targetId = '19bf4492ce22d213';

  const full = await gmail.users.messages.get({ userId: 'me', id: targetId, format: 'full' });
  const rawBase64 = full.data.payload.body.data;
  const rawBinary = Buffer.from(rawBase64, 'base64url').toString('latin1');
  const decoded = decodeQuotedPrintable(rawBinary);

  const idx = decoded.indexOf('res_id');
  console.log('Context around "res_id" in the DECODED text:');
  console.log(decoded.slice(Math.max(0, idx - 250), idx + 400));
})();

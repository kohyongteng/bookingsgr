const lib = require('./lib');

// We need extractBody directly - let's require it by re-reading the module internals
const fs = require('fs');
const libSource = fs.readFileSync('./lib.js', 'utf8');
console.log('Does lib.js export extractBody?', libSource.includes('module.exports') && libSource.includes('extractBody'));

(async () => {
  const gmail = lib.getGmailClient();
  const targetId = '19bf4492ce22d213';
  const full = await gmail.users.messages.get({ userId: 'me', id: targetId, format: 'full' });

  console.log('Top-level payload mimeType:', full.data.payload.mimeType);
  console.log('Top-level payload has body.data?', !!(full.data.payload.body && full.data.payload.body.data));
  console.log('Top-level payload has parts?', !!full.data.payload.parts);
  console.log('Top-level payload headers count:', full.data.payload.headers ? full.data.payload.headers.length : 0);

  const cte = full.data.payload.headers.find(h => h.name.toLowerCase() === 'content-transfer-encoding');
  console.log('Content-Transfer-Encoding header found on payload:', cte ? cte.value : 'NOT FOUND');
})();

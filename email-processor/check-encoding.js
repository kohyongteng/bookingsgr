const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();
  const targetId = '19bf4492ce22d213';
  const full = await gmail.users.messages.get({ userId: 'me', id: targetId, format: 'full' });

  function findEncodings(part, path) {
    if (!part) return;
    const headers = part.headers || [];
    const cte = headers.find(h => h.name.toLowerCase() === 'content-transfer-encoding');
    console.log(path, '| mimeType:', part.mimeType, '| Content-Transfer-Encoding:', cte ? cte.value : '(none)');
    if (part.parts) part.parts.forEach((p, i) => findEncodings(p, path + '.' + i));
  }
  findEncodings(full.data.payload, 'root');
})();

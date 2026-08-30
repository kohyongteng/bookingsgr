const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient();
  const targetId = '19bf4492ce22d213';

  const meta = await gmail.users.messages.get({
    userId: 'me',
    id: targetId,
    format: 'metadata',
    metadataHeaders: ['Subject'],
  });
  const candidate = lib.parseSubjectOnly(meta.data, new Date('2026-07-15'));

  const full = await gmail.users.messages.get({ userId: 'me', id: targetId, format: 'full' });
  const result = lib.parseBody(candidate, full.data);

  console.log('parseBody result:', result);

  // If null, let's see the raw HTML to find why the link regex failed
  if (!result) {
    const fs = require('fs');
    function extractHtml(payload) {
      let html = '';
      function walk(part) {
        if (!part) return;
        if (part.mimeType === 'text/html' && part.body && part.body.data) {
          html += Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
        if (part.parts) part.parts.forEach(walk);
      }
      walk(payload);
      return html;
    }
    const html = extractHtml(full.data.payload);
    fs.writeFileSync('./debug-email-body.html', html);
    console.log('Saved raw HTML to debug-email-body.html for inspection');
    console.log('HTML length:', html.length);
    // Search for any admin.booking.com link at all
    const anyLink = html.match(/href="(https:\/\/admin\.booking\.com[^"]*)"/);
    console.log('Any admin.booking.com link found?', anyLink ? anyLink[1] : 'NONE FOUND');
  }
})();

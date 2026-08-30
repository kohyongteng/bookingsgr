const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const PORT = 3005;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
];

function getAccountArg() {
  const arg = process.argv.find((a) => a.startsWith('--account='));
  return arg ? arg.split('=')[1] : 'default';
}

function loadCredentials() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error('Could not find "installed" or "web" key in credentials.json');
  return creds;
}

async function main() {
  const account = getAccountArg();
  const tokenPath = account === 'default'
    ? path.join(__dirname, 'token.json')
    : path.join(__dirname, `token_${account}.json`);

  const creds = loadCredentials();
  const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log(`\nAuthorizing account: ${account}`);
  console.log(`Token will be saved to: ${tokenPath}\n`);
  console.log('Open this URL in a browser ON THIS SAME MACHINE (the mini PC Chrome window):\n');
  console.log(authUrl);
  console.log('\nMake sure to log in with the correct Google account for this authorization.\n');
  console.log('Waiting for you to approve access in the browser...\n');

  const server = http.createServer(async (req, res) => {
    try {
      const qs = url.parse(req.url, true).query;
      if (!qs.code) {
        res.end('No code received. You can close this tab.');
        return;
      }
      const { tokens } = await oAuth2Client.getToken(qs.code);
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
      res.end('Authorization successful! You can close this tab and return to the terminal.');
      console.log(`Saved ${tokenPath} — authorization complete.`);
      server.close();
      process.exit(0);
    } catch (err) {
      res.end('Error during authorization. Check the terminal for details.');
      console.error('Error retrieving token:', err.message);
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`(Local callback server listening on port ${PORT})`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

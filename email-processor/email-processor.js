const { google } = require('googleapis');
const fs = require('fs');
const Database = require('better-sqlite3');

// ---------- CONFIG ----------
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';
const DB_PATH = 'C:\\apps\\shared-data\\bookings.db';
const SCRAPER_URL = 'http://localhost:3002/scrape';
const LAST_CHECK_PATH = './last_check.json';
const BLOCKED_FLAG_PATH = './blocked.flag';
const ADMIN_EMAIL = 'teng20240301@gmail.com'; // change if needed
const LIVE_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------- AUTH ----------
function loadCredentials() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error('Could not find "installed" or "web" key in credentials.json');
  return creds;
}

function getAuthClient() {
  const creds = loadCredentials();
  const oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('token.json not found. Run "node authorize.js" first.');
  }
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

// ---------- GMAIL HELPERS ----------
function decodeMimeWord(str) {
  if (!str) return str;
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, enc, data) => {
    if (enc.toUpperCase() === 'B') {
      return Buffer.from(data, 'base64').toString('utf8');
    }
    const text = data
      .replace(/_/g, ' ')
      .replace(/=([A-Fa-f0-9]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(text, 'binary').toString('utf8');
  });
}

function getHeader(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(payload) {
  let html = '';
  let text = '';
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html += Buffer.from(part.body.data, 'base64url').toString('utf8');
    } else if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      text += Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return { html, text };
}

async function listAllMessages(gmail, q) {
  let messages = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    if (res.data.messages) messages = messages.concat(res.data.messages);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return messages;
}

function createRawEmail(to, subject, body) {
  const str = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');
  return Buffer.from(str).toString('base64url');
}

async function sendAlertEmail(gmail, to, subject, body) {
  const raw = createRawEmail(to, subject, body);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ---------- PARSING ----------
function parseMessage(msg) {
  const headers = msg.payload.headers;
  const subject = decodeMimeWord(getHeader(headers, 'Subject'));
  const { html, text } = extractBody(msg.payload);

  let type = 'UNKNOWN';
  if (subject.includes('New booking!')) type = 'NEW';
  else if (subject.includes('Modified booking!')) type = 'MODIFIED';
  else if (subject.includes('Canceled booking!')) type = 'CANCELLED';
  if (type === 'UNKNOWN') return null;

  const subjectMatch = subject.match(/\((\d+),\s*\w+,\s*(\w+ \d+, \d{4})\)/);
  if (!subjectMatch) return null;

  const bookingNumber = subjectMatch[1];
  const subjectCheckIn = subjectMatch[2];
  const checkInDate = new Date(subjectCheckIn);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(checkInDate.getTime()) || checkInDate < today) return null;

  let bookingLink = null;
  let guestName = null;

  if (type === 'CANCELLED') {
    const guestMatch = text.match(/Reservation \d+ for (.+?) has been/);
    guestName = guestMatch ? guestMatch[1].trim() : null;
  } else {
    const linkMatch = html.match(
      /href="(https:\/\/admin\.booking\.com\/hotel\/hoteladmin\/extranet_ng\/manage\/booking\.html\?[^"]+)"/
    );
    bookingLink = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : null;
    if (!bookingLink) return null;
  }

  return {
    type,
    bookingNumber,
    bookingLink,
    guestName,
    subjectCheckIn,
    receivedDate: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : null,
  };
}

function dedupe(parsedList) {
  const map = {};
  for (const item of parsedList) {
    const existing = map[item.bookingNumber];
    if (!existing || new Date(item.receivedDate) > new Date(existing.receivedDate)) {
      map[item.bookingNumber] = item;
    }
  }
  return Object.values(map);
}

// ---------- DATABASE ----------
function isAlreadyScraped(db, bookingNumber) {
  const row = db.prepare('SELECT room_category FROM bookings WHERE booking_number = ?').get(bookingNumber);
  return !!(row && row.room_category);
}

function saveCancelled(db, b) {
  db.prepare(`
    INSERT INTO bookings (booking_number, platform, guest_name, status, updated_at)
    VALUES (?, 'booking.com', ?, 'cancelled', CURRENT_TIMESTAMP)
    ON CONFLICT(booking_number) DO UPDATE SET
      status = 'cancelled',
      guest_name = excluded.guest_name,
      updated_at = CURRENT_TIMESTAMP
  `).run(b.bookingNumber, b.guestName);
}

function saveBooking(db, bookingNumber, status, scraped) {
  db.prepare(`
    INSERT INTO bookings (
      booking_number, platform, room_category, guest_name,
      check_in, check_out, status, updated_at
    )
    VALUES (?, 'booking.com', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(booking_number) DO UPDATE SET
      room_category = excluded.room_category,
      guest_name = excluded.guest_name,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run(bookingNumber, scraped.roomType, scraped.guestName, scraped.checkIn, scraped.checkOut, status);
}

// ---------- SCRAPER ----------
function randomDelayMs() {
  return Math.floor(Math.random() * 12000) + 8000; // 8-20 seconds
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrape(bookingLink) {
  const res = await fetch(SCRAPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingLink }),
  });
  return res.json();
}

// ---------- DATE / STATE HELPERS ----------
function formatGmailDate(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}/${m}/${day}`;
}

function getLastCheckDate() {
  if (fs.existsSync(LAST_CHECK_PATH)) {
    const data = JSON.parse(fs.readFileSync(LAST_CHECK_PATH, 'utf8'));
    return new Date(data.lastCheck);
  }
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function saveLastCheckDate(date) {
  fs.writeFileSync(LAST_CHECK_PATH, JSON.stringify({ lastCheck: date.toISOString() }, null, 2));
}

// ---------- MAIN ----------
async function runOnce(mode) {
  if (fs.existsSync(BLOCKED_FLAG_PATH)) {
    console.log(
      `[${new Date().toISOString()}] blocked.flag present â€” skipping this run. ` +
      `Log back into the Chrome window on the mini PC, then delete blocked.flag to resume.`
    );
    return;
  }

  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const db = new Database(DB_PATH);

  let afterDate;
  if (mode === 'backfill') {
    const d = new Date();
    d.setMonth(d.getMonth() - 9);
    afterDate = formatGmailDate(d);
  } else {
    afterDate = formatGmailDate(getLastCheckDate());
  }

  const query = `from:booking.com subject:"booking!" after:${afterDate}`;
  console.log(`[${new Date().toISOString()}] Querying Gmail: ${query}`);

  const messages = await listAllMessages(gmail, query);
  console.log(`Found ${messages.length} matching emails.`);

  const parsed = [];
  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const p = parseMessage(full.data);
    if (p) parsed.push(p);
  }
  console.log(`${parsed.length} are future-dated bookings of a known type.`);

  const deduped = dedupe(parsed);
  console.log(`${deduped.length} remain after deduplication.`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const b of deduped) {
    if (b.type === 'CANCELLED') {
      saveCancelled(db, b);
      processed++;
      console.log(`Cancelled: ${b.bookingNumber} (${b.guestName || 'unknown guest'})`);
      continue;
    }

    if (isAlreadyScraped(db, b.bookingNumber)) {
      skipped++;
      continue;
    }

    await sleep(randomDelayMs());

    let result;
    try {
      result = await scrape(b.bookingLink);
    } catch (err) {
      console.error(`Scrape request failed for ${b.bookingNumber}: ${err.message}`);
      failed++;
      continue;
    }

    if (result.status === 'BLOCKED' || result.status === 'LOGIN_REQUIRED') {
      console.error(`STOPPING: ${result.status} â€” ${result.message}`);
      fs.writeFileSync(BLOCKED_FLAG_PATH, new Date().toISOString());
      try {
        await sendAlertEmail(
          gmail,
          ADMIN_EMAIL,
          `Booking.com processor stopped: ${result.status}`,
          `${result.message}\n\nStopped at booking ${b.bookingNumber}.\n` +
          `Please log in to the Chrome window on the mini PC, then delete blocked.flag in the email-processor folder to resume.`
        );
        console.log('Alert email sent.');
      } catch (err) {
        console.error('Failed to send alert email:', err.message);
      }
      db.close();
      if (mode === 'backfill') process.exit(1);
      return; // live mode: let the next scheduled cycle check blocked.flag and skip until resolved
    }

    if (result.status !== 'OK') {
      console.error(`Scrape failed for ${b.bookingNumber}: ${JSON.stringify(result)}`);
      failed++;
      continue;
    }

    const status = b.type === 'MODIFIED' ? 'modified' : 'new';
    saveBooking(db, b.bookingNumber, status, result);
    processed++;
    console.log(`Saved ${b.bookingNumber} â€” ${result.guestName} (${result.roomType})`);
  }

  db.close();
  console.log(
    `\n[${new Date().toISOString()}] Done. Processed: ${processed}, Skipped (already saved): ${skipped}, Failed: ${failed}`
  );

  if (mode === 'live') {
    saveLastCheckDate(new Date());
  }
}

// ---------- ENTRY POINT ----------
const mode = process.argv.includes('--mode=live') ? 'live' : 'backfill';

if (mode === 'live') {
  console.log(`Starting live mode â€” checking every ${LIVE_POLL_INTERVAL_MS / 60000} minutes.`);
  runOnce('live').catch((err) => console.error('Cycle error:', err));
  setInterval(() => {
    runOnce('live').catch((err) => console.error('Cycle error:', err));
  }, LIVE_POLL_INTERVAL_MS);
} else {
  runOnce('backfill').catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

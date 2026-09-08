const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const DB_PATH = 'C:\\apps\\shared-data\\bookings.db';
const SCRAPER_URL = 'http://localhost:3002/scrape';

// ---------- AUTH ----------
function loadCredentials() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error('Could not find "installed" or "web" key in credentials.json');
  return creds;
}

function getAuthClient(account = 'default') {
  const creds = loadCredentials();
  const tokenPath = account === 'default'
    ? TOKEN_PATH
    : path.join(__dirname, `token_${account}.json`);
  const oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'http://localhost:3005/oauth2callback'
  );
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`${tokenPath} not found. Run "node authorize.js --account=${account}" first.`);
  }
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

function getGmailClient(account = 'default') {
  const auth = getAuthClient(account);
  return google.gmail({ version: 'v1', auth });
}

function getCalendarClient(account = 'default') {
  const auth = getAuthClient(account);
  return google.calendar({ version: 'v3', auth });
}

// ---------- GMAIL PARSING HELPERS ----------
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

function decodeQuotedPrintable(rawBinaryStr) {
  // Remove soft line breaks (= at end of line means "continue on next line")
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

function getPartHeader(part, name) {
  if (!part.headers) return null;
  const h = part.headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function decodePartBody(part) {
  if (!part.body || !part.body.data) return '';
  const encoding = (getPartHeader(part, 'Content-Transfer-Encoding') || '').toLowerCase();
  if (encoding.includes('quoted-printable')) {
    // Decode base64url to raw bytes first (as latin1, 1 char per byte), THEN un-escape the QP sequences
    const rawBinary = Buffer.from(part.body.data, 'base64url').toString('latin1');
    return decodeQuotedPrintable(rawBinary);
  }
  // Default: base64url-encoded raw UTF-8 content (covers "binary", "7bit", "8bit", or unspecified)
  return Buffer.from(part.body.data, 'base64url').toString('utf8');
}

function extractBody(payload) {
  let html = '';
  let text = '';
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html += decodePartBody(part);
    } else if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      text += decodePartBody(part);
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

// Phase A — cheap check using ONLY the subject line (no body download needed).
// Returns null if this email is irrelevant (unknown type or already in the past).
function parseSubjectOnly(msg, cutoffDate) {
  const headers = msg.payload.headers;
  const subject = decodeMimeWord(getHeader(headers, 'Subject'));

  let type = 'UNKNOWN';
  if (subject.includes('New booking!') || subject.includes('New last-minute booking')) type = 'NEW';
  else if (subject.includes('Modified booking!')) type = 'MODIFIED';
  else if (subject.includes('Canceled booking!')) type = 'CANCELLED';
  if (type === 'UNKNOWN') return null;

  const subjectMatch = subject.match(/\((\d+),\s*\w+,\s*(\w+ \d+, \d{4})\)/);
  if (!subjectMatch) return null;

  const bookingNumber = subjectMatch[1];
  const subjectCheckIn = subjectMatch[2];
  const checkInDate = new Date(subjectCheckIn);

  const cutoff = cutoffDate ? new Date(cutoffDate) : new Date();
  cutoff.setHours(0, 0, 0, 0);

  if (isNaN(checkInDate.getTime()) || checkInDate < cutoff) return null;

  return {
    type,
    bookingNumber,
    subjectCheckIn,
    subject,
    receivedDate: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : null,
  };
}

const HOTEL_ID_CONSTANT = '11643095';

function buildBookingLink(bookingNumber) {
  return `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=${bookingNumber}&hotel_id=${HOTEL_ID_CONSTANT}&lang=en-us`;
}

// Phase B — only called for messages that survived parseSubjectOnly.
// Needs the full body to extract the booking link or (for cancellations) guest name.
function parseBody(candidate, fullMsg) {
  const bookingLink = buildBookingLink(candidate.bookingNumber);

  let guestName = null;
  if (candidate.type === 'CANCELLED' && fullMsg) {
    const { text } = extractBody(fullMsg.payload);
    const guestMatch = text.match(/Reservation \d+ for (.+?) has been/);
    guestName = guestMatch ? guestMatch[1].trim() : null;
  }

  return {
    type: candidate.type,
    bookingNumber: candidate.bookingNumber,
    bookingLink: candidate.type === 'CANCELLED' ? null : bookingLink,
    guestName,
    subjectCheckIn: candidate.subjectCheckIn,
    receivedDate: candidate.receivedDate,
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
function openDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_queue (
      booking_number TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject_check_in TEXT,
      email_received_at TEXT,
      detected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      gmail_message_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_airbnb_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_name TEXT NOT NULL,
      room_number TEXT,
      requested_check_in TEXT,
      requested_check_out TEXT,
      detected_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_sync (
      booking_number TEXT NOT NULL,
      night_date TEXT NOT NULL,
      event_id TEXT,
      last_title TEXT,
      last_color TEXT,
      PRIMARY KEY (booking_number, night_date)
    )
  `);

  // --- Financial columns on bookings (added 2026-09-08) ---------------------
  // Recorded for reporting/analysis only - nothing operational reads these, so
  // a booking with no financials is still perfectly valid (and most historical
  // rows will stay null). Amounts are REAL in the booking's own currency.
  //
  // Semantics, which differ slightly per platform - both are stored as
  // "what the guest paid" / "what the platform took" / "what we receive":
  //   Airbnb      gross = TOTAL(MYR), tax = Occupancy taxes,
  //               platform_fee = Host service fee (negative), net = YOU EARN
  //   Booking.com gross = Total price, tax = tourism fee portion,
  //               platform_fee = Commission and charges (negative),
  //               net = gross - commission
  // platform_fee is stored NEGATIVE on both, so summing columns works directly.
  const existingCols = new Set(db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name));
  const financialCols = {
    currency: 'TEXT',
    room_fee: 'REAL',
    tax_amount: 'REAL',
    gross_amount: 'REAL',
    platform_fee: 'REAL',
    net_payout: 'REAL',
    financials_source: 'TEXT', // 'airbnb-email' | 'booking-scrape' | 'manual'
    financials_updated_at: 'TEXT',
  };
  for (const [name, type] of Object.entries(financialCols)) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`);
    }
  }

  return db;
}

// Maps our internal email "type" to the status string used in the main bookings table.
function typeToBookingStatus(type) {
  if (type === 'NEW') return 'new';
  if (type === 'MODIFIED') return 'modified';
  if (type === 'CANCELLED') return 'cancelled';
  return null;
}

// Called by the detector every ~5 minutes for each candidate found in Gmail.
// Only adds/updates the pending_queue if this represents genuinely new information -
// i.e. not already correctly reflected in the main bookings table.
function upsertPendingQueue(db, candidate) {
  const mainRow = db.prepare('SELECT status FROM bookings WHERE booking_number = ?').get(candidate.bookingNumber);
  // Multi-room bookings are saved as "<bookingNumber>-1", "<bookingNumber>-2", etc.
  // (see saveMultiRoomBooking) - there is never a row with the plain booking number
  // for those, so without this fallback this check always misses them and the
  // detector re-queues an already-synced multi-room booking for rescraping forever.
  // All rooms from one scrape share the same status, so checking one is sufficient.
  const multiRoomRow = mainRow
    ? null
    : db.prepare('SELECT status FROM bookings WHERE booking_number LIKE ? LIMIT 1').get(`${candidate.bookingNumber}-%`);
  const effectiveRow = mainRow || multiRoomRow;
  const expectedStatus = typeToBookingStatus(candidate.type);

  if (effectiveRow && effectiveRow.status === expectedStatus) {
    // Already correctly synced with this exact status - nothing to queue.
    return 'already-synced';
  }

  const existing = db
    .prepare('SELECT type, status FROM pending_queue WHERE booking_number = ?')
    .get(candidate.bookingNumber);

  if (!existing) {
    db.prepare(`
      INSERT INTO pending_queue (booking_number, type, subject_check_in, email_received_at, detected_at, status, gmail_message_id)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending', ?)
    `).run(candidate.bookingNumber, candidate.type, candidate.subjectCheckIn, candidate.receivedDate, candidate.gmailMessageId || null);
    return 'inserted';
  }

  if (existing.type !== candidate.type) {
    // Fresh information (status changed since we last saw it) - reset to pending
    // regardless of previous state, since this needs fresh handling.
    db.prepare(`
      UPDATE pending_queue SET
        type = ?, subject_check_in = ?, email_received_at = ?, detected_at = CURRENT_TIMESTAMP,
        status = 'pending', error_message = NULL, gmail_message_id = ?
      WHERE booking_number = ?
    `).run(candidate.type, candidate.subjectCheckIn, candidate.receivedDate, candidate.gmailMessageId || null, candidate.bookingNumber);
    return 'updated-type-changed';
  }

  // Same type as before - just refresh the timestamp/message id, leave status/error alone
  // (so a 'failed' row doesn't get silently reset just because we saw the same email again).
  db.prepare(`
    UPDATE pending_queue SET email_received_at = ?, detected_at = CURRENT_TIMESTAMP, gmail_message_id = ?
    WHERE booking_number = ?
  `).run(candidate.receivedDate, candidate.gmailMessageId || null, candidate.bookingNumber);
  return 'touched';
}

function getPendingQueue(db) {
  return db.prepare('SELECT * FROM pending_queue ORDER BY email_received_at DESC').all();
}

function getPendingCount(db) {
  const row = db.prepare("SELECT COUNT(*) as count FROM pending_queue WHERE status = 'pending'").get();
  const failedRow = db.prepare("SELECT COUNT(*) as count FROM pending_queue WHERE status = 'failed'").get();
  return { pending: row.count, failed: failedRow.count };
}

function markPendingFailed(db, bookingNumber, errorMessage) {
  db.prepare("UPDATE pending_queue SET status = 'failed', error_message = ? WHERE booking_number = ?").run(
    errorMessage,
    bookingNumber
  );
}

function removeFromPendingQueue(db, bookingNumber) {
  db.prepare('DELETE FROM pending_queue WHERE booking_number = ?').run(bookingNumber);
}

function clearAllErrors(db) {
  const result = db.prepare("UPDATE pending_queue SET status = 'pending', error_message = NULL WHERE status = 'failed'").run();
  return result.changes;
}

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

  // Multi-room bookings are split into "<bookingNumber>-1", "<bookingNumber>-2",
  // etc. (see saveMultiRoomBooking). A cancellation email always references the
  // ORIGINAL booking number, so without this, a cancelled multi-room booking's
  // rooms would stay "occupied" in the system forever.
  db.prepare(`
    UPDATE bookings SET status = 'cancelled', guest_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE booking_number LIKE ? AND status != 'cancelled'
  `).run(b.guestName, `${b.bookingNumber}-%`);
}

// Extracts the guest name straight from a Booking.com cancellation email's body -
// no scraping/login needed, so cancellations can apply the moment they're detected
// instead of waiting for a manual Sync Now (which is only needed for NEW/MODIFIED,
// since those require the Extranet scrape for room/dates).
function extractCancelledGuestName(text) {
  const guestMatch = text.match(/Reservation \d+ for (.+?) has been/);
  return guestMatch ? guestMatch[1].trim() : null;
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
    WHERE bookings.status != 'cancelled'
  `).run(bookingNumber, scraped.roomType, scraped.guestName, scraped.checkIn, scraped.checkOut, status);
}

// A Booking.com reservation can cover MORE THAN ONE physical room under a single
// booking number (e.g. "Total rooms: 2"). The schema/availability-check/calendar
// sync all assume one row = one room, so each room gets its own row here, keyed
// "<bookingNumber>-1", "<bookingNumber>-2", etc. - each independently trackable,
// so a dropped second room can never silently go unblocked again.
function saveMultiRoomBooking(db, bookingNumber, status, result) {
  const existingPlain = db.prepare('SELECT status FROM bookings WHERE booking_number = ?').get(bookingNumber);
  if (existingPlain && existingPlain.status === 'cancelled') {
    // A stale NEW/MODIFIED scrape arriving after a real cancellation - never
    // resurrect it (same "cancelled always wins" rule as everywhere else).
    return;
  }
  // If this booking was previously mis-saved as a single row (before this fix
  // existed), remove that old wrong row - it's replaced by one row per room.
  db.prepare('DELETE FROM bookings WHERE booking_number = ?').run(bookingNumber);

  result.rooms.forEach((room, i) => {
    const subBookingNumber = `${bookingNumber}-${i + 1}`;
    saveBooking(db, subBookingNumber, status, {
      roomType: room.roomType,
      guestName: result.guestName,
      checkIn: room.checkIn,
      checkOut: room.checkOut,
    });
  });
}

// ---------- FINANCIALS ----------

// Pulls "RM 1,234.56" (or "-RM 150.66") out of a string as a signed number.
function parseMoney(str) {
  if (str == null) return null;
  const raw = String(str).replace(/,/g, '');
  const m = raw.match(/-?\s*RM\s*(-?[\d.]+)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return /-\s*RM/i.test(raw) ? -Math.abs(n) : n;
}

// Finds a labelled amount, tolerating the amount being on the same line or the
// next one (Airbnb's plain-text mail wraps inconsistently between templates).
function pickLabelledMoney(text, label) {
  const sameLine = text.match(new RegExp(`${label}[^\\r\\n]*?(-?RM\\s*[\\d,.]+)`, 'i'));
  if (sameLine) return parseMoney(sameLine[1]);
  const nextLine = text.match(new RegExp(`${label}[^\\r\\n]*\\r?\\n\\s*(-?RM\\s*[\\d,.]+)`, 'i'));
  return nextLine ? parseMoney(nextLine[1]) : null;
}

// Extracts the money block from an Airbnb "Reservation confirmed" host email.
// Verified against real mail; see the layout note in openDb() for semantics.
// Returns null when the email carries no recognisable payout block.
function parseAirbnbFinancials(text) {
  const codeMatch = text.match(/CONFIRMATION CODE\s*\r?\n\s*([A-Z0-9]{6,})/i);
  const currencyMatch = text.match(/TOTAL\s*\(([A-Z]{3})\)/i);

  const grossAmount = pickLabelledMoney(text, 'TOTAL\\s*\\([A-Z]{3}\\)');
  const netPayout = pickLabelledMoney(text, 'YOU EARN');
  // "4 nights room fee" but "1 night room fee" on single-night stays.
  const roomFee = pickLabelledMoney(text, 'nights? room fee');
  const taxAmount = pickLabelledMoney(text, 'Occupancy taxes');
  let platformFee = pickLabelledMoney(text, 'Host service fee');
  if (platformFee != null && platformFee > 0) platformFee = -platformFee; // always stored negative

  if (!codeMatch || grossAmount == null || netPayout == null) return null;

  return {
    confirmationCode: codeMatch[1].trim(),
    currency: currencyMatch ? currencyMatch[1].toUpperCase() : 'MYR',
    roomFee,
    taxAmount,
    grossAmount,
    platformFee,
    netPayout,
  };
}

// Writes financials onto an existing booking row. Deliberately does NOT create
// a row - financials are supplementary to a booking the normal pipeline owns,
// so a code with no matching booking is reported rather than silently inserted.
function saveFinancials(db, bookingNumber, f, source) {
  const result = db.prepare(`
    UPDATE bookings SET
      currency = ?, room_fee = ?, tax_amount = ?, gross_amount = ?,
      platform_fee = ?, net_payout = ?, financials_source = ?,
      financials_updated_at = CURRENT_TIMESTAMP
    WHERE booking_number = ?
  `).run(
    f.currency || 'MYR',
    f.roomFee ?? null,
    f.taxAmount ?? null,
    f.grossAmount ?? null,
    f.platformFee ?? null,
    f.netPayout ?? null,
    source,
    bookingNumber
  );
  return result.changes > 0;
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

// ---------- EMAIL ALERTS ----------
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

// Kept distinct from createRawEmail/sendAlertEmail above (those must stay
// new-thread-only for admin alerts). This one replies WITHIN an existing
// Gmail thread - required for a reply to actually relay into an Airbnb
// guest's in-app chat. `to` must be the target message's OWN `Reply-To`
// header (a unique per-message <hash>@reply.airbnb.com address, not a fixed
// address - re-extract it fresh for every send) and `inReplyTo` its
// `Message-Id`. See airbnbChatReply.js.
function createThreadedRawEmail({ to, subject, inReplyTo, body }) {
  const str = [
    `To: ${to}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${inReplyTo}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');
  return Buffer.from(str).toString('base64url');
}

async function sendThreadedReply(gmail, { threadId, to, inReplyTo, subject, body }) {
  const raw = createThreadedRawEmail({ to, subject, inReplyTo, body });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
}

// ---------- DATE HELPERS ----------
function formatGmailDate(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}/${m}/${day}`;
}

function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- AIRBNB PARSING ----------
// Edit this map directly when new rooms are added (e.g. #15, #16).
const AIRBNB_ROOM_MAP = {
  '01': 'Normal Room', '02': 'Normal Room', '03': 'Normal Room', '04': 'Normal Room',
  '05': 'Normal Room', '07': 'Normal Room', '09': 'Normal Room', '14': 'Normal Room',
  '06': 'Double Bedroom', '08': 'Double Bedroom', '10': 'Double Bedroom',
  '11': 'Double Bedroom', '12': 'Double Bedroom',
  '15': 'Double Bedroom', '16': 'Double Bedroom',
};

function airbnbExtractRoomNumber(text) {
  // The room number tag "#NN" is always the first thing on its own line
  // (optionally preceded by a short "BH01 · " prefix), regardless of whatever
  // descriptive text follows - which the host can rename anytime. Anchoring to
  // line position rather than nearby keywords makes this resilient to that.
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^(?:[A-Za-z]{2}\d+\s*[·•\-]?\s*)?#(\d{1,2})(?:[^\d]|$)/);
    if (match) return match[1].padStart(2, '0');
  }
  return null;
}

function airbnbRoomCategoryFor(roomNumber) {
  if (!roomNumber) return null;
  return AIRBNB_ROOM_MAP[roomNumber] || 'UNKNOWN';
}

function airbnbInferYear(monthDayStr, receivedDate) {
  const cleaned = monthDayStr.replace(/^\w{3},\s*/, '');
  const received = new Date(receivedDate);
  // Compare calendar dates only (ignore time-of-day). Without this, a same-day
  // (last-minute) booking's check-in - which parses to midnight - would always
  // look "earlier than" the email's received timestamp later that same day,
  // wrongly triggering the "this date must be next year" rollover below.
  received.setHours(0, 0, 0, 0);
  const candidateThisYear = new Date(`${cleaned}, ${received.getFullYear()}`);
  if (candidateThisYear < received) {
    return new Date(`${cleaned}, ${received.getFullYear() + 1}`);
  }
  return candidateThisYear;
}

function parseAirbnbDateString(dateStr, receivedDate) {
  // Older Airbnb emails include the year directly, e.g. "Fri, Jan 2, 2026" -
  // in that case just parse it directly, no inference needed at all (more
  // reliable than guessing). Current-format emails omit the year, e.g.
  // "Mon, Aug 3" - those still need airbnbInferYear()'s guess.
  const yearMatch = dateStr.match(/^(.*\d{1,2}),\s*(\d{4})$/);
  if (yearMatch) {
    return new Date(`${yearMatch[1]}, ${yearMatch[2]}`);
  }
  return airbnbInferYear(dateStr, receivedDate);
}

function parseAirbnbNewBooking(subject, text, receivedDate) {
  const subjectMatch = subject.match(/^Reservation confirmed - (.+) arrives (\w+ \d+)$/);
  if (!subjectMatch) return null;

  const guestName = subjectMatch[1];
  const codeMatch = text.match(/CONFIRMATION CODE\s*\n(\S+)/i) || text.match(/reservations\/details\/([A-Z0-9]+)/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;
  const roomNumber = airbnbExtractRoomNumber(text);

  const dateMatch = text.match(
    /Check-in\s+Checkout[\s\S]*?(\w{3}, \w{3} \d{1,2}(?:, \d{4})?)\s+(\w{3}, \w{3} \d{1,2}(?:, \d{4})?)/
  );
  let checkIn = null;
  let checkOut = null;
  if (dateMatch) {
    checkIn = parseAirbnbDateString(dateMatch[1], receivedDate);
    checkOut = parseAirbnbDateString(dateMatch[2], receivedDate);
  }

  return {
    type: 'NEW',
    confirmationCode,
    guestName,
    roomNumber,
    roomCategory: airbnbRoomCategoryFor(roomNumber),
    checkIn: checkIn ? toLocalISODate(checkIn) : null,
    checkOut: checkOut ? toLocalISODate(checkOut) : null,
  };
}

function parseAirbnbCancellation(subject) {
  const match = subject.match(/^Canceled: Reservation (\S+) for/);
  if (!match) return null;
  return { type: 'CANCELLED', confirmationCode: match[1] };
}

// Airbnb's own Terms-of-Service-violation cancellation ("we've canceled the
// reservation and refunded payment") uses a different subject entirely -
// "Reservation ABCDEFGH has been canceled" - where "ABCDEFGH" is a literal,
// un-substituted placeholder (an Airbnb template bug), not the real code.
// The real confirmation code only appears in the body, e.g. "...update
// about reservation HMWK5AWS9Q. It looks like...".
function parseAirbnbRiskCancellation(text) {
  const match = text.match(/reservation\s+([A-Z0-9]{8,14})\b/);
  if (!match) return null;
  return { type: 'CANCELLED', confirmationCode: match[1] };
}

function parseAirbnbChangeRequest(subject, text, receivedDate) {
  const subjectMatch = subject.match(/^(.+) wants to change their reservation$/);
  if (!subjectMatch) return null;

  const guestName = subjectMatch[1];
  const roomNumber = airbnbExtractRoomNumber(text);

  if (text.includes('REQUESTED DATES')) {
    const dateMatch = text.match(
      /REQUESTED DATES\s*\n\s*\n?(\w+ \d{1,2}, \d{4})\s*-\s*(\w+ \d{1,2}, \d{4})/
    );
    return {
      type: 'CHANGE_REQUEST_DATES',
      guestName,
      roomNumber,
      requestedCheckIn: dateMatch ? toLocalISODate(new Date(dateMatch[1])) : null,
      requestedCheckOut: dateMatch ? toLocalISODate(new Date(dateMatch[2])) : null,
      receivedDate,
    };
  }

  if (text.includes('REQUESTED GUESTS')) {
    return { type: 'CHANGE_REQUEST_GUESTS_ONLY', guestName, roomNumber };
  }

  return { type: 'CHANGE_REQUEST_UNKNOWN', guestName, roomNumber };
}

function parseAirbnbUpdateConfirmed(text) {
  const nameMatch = text.match(/YOUR RESERVATION WITH (.+) HAS BEEN UPDATED/i);
  if (!nameMatch) return null;

  const guestName = nameMatch[1];
  const roomNumber = airbnbExtractRoomNumber(text);
  const codeMatch = text.match(/reservations\/details\/([A-Z0-9]+)/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;

  return { type: 'UPDATE_CONFIRMED', guestName, roomNumber, confirmationCode };
}

// ---------- AIRBNB DATABASE HELPERS ----------
// Maps Airbnb's Double Bedroom listing numbers to their usual physical room.
// Only used as a DEFAULT on first save - never overwrites an existing manual assignment.
const AIRBNB_DOUBLE_DEFAULT_ROOM = {
  '08': 'N1901',
  '06': 'N2206',
  '11': 'N2401',
  '12': 'N3001',
  '10': 'S1901',
};

function saveAirbnbBooking(db, parsed) {
  const existing = db.prepare('SELECT assigned_room FROM bookings WHERE booking_number = ?').get(parsed.confirmationCode);
  let assignedRoom = existing ? existing.assigned_room : null;

  if (!assignedRoom && parsed.roomCategory === 'Double Bedroom') {
    assignedRoom = AIRBNB_DOUBLE_DEFAULT_ROOM[parsed.roomNumber] || null;
  }

  db.prepare(`
    INSERT INTO bookings (
      booking_number, platform, room_category, room_number, assigned_room,
      guest_name, check_in, check_out, status, updated_at
    )
    VALUES (?, 'airbnb', ?, ?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP)
    ON CONFLICT(booking_number) DO UPDATE SET
      room_category = excluded.room_category,
      room_number = excluded.room_number,
      guest_name = excluded.guest_name,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      updated_at = CURRENT_TIMESTAMP
    WHERE bookings.status != 'cancelled'
  `).run(
    parsed.confirmationCode,
    parsed.roomCategory,
    parsed.roomNumber,
    assignedRoom,
    parsed.guestName,
    parsed.checkIn,
    parsed.checkOut
  );
}

function saveAirbnbCancellation(db, confirmationCode) {
  db.prepare(`
    UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE booking_number = ?
  `).run(confirmationCode);
}

function queueAirbnbChangeRequest(db, parsed) {
  db.prepare(`
    INSERT INTO pending_airbnb_changes (guest_name, room_number, requested_check_in, requested_check_out, detected_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(parsed.guestName, parsed.roomNumber, parsed.requestedCheckIn, parsed.requestedCheckOut);
}

// Called when an UPDATE_CONFIRMED email arrives. Looks for a matching pending
// change request (same guest name + room number, case-insensitive, within 72 hours)
// and if found, applies the requested dates to the actual booking via its confirmation code.
function applyAirbnbUpdate(db, updateInfo) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 72);

  const candidates = db
    .prepare(`SELECT * FROM pending_airbnb_changes WHERE room_number = ? AND detected_at >= ?`)
    .all(updateInfo.roomNumber, cutoff.toISOString());

  const match = candidates.find(
    (c) => c.guest_name.trim().toLowerCase() === updateInfo.guestName.trim().toLowerCase()
  );

  if (!match) {
    return { applied: false, reason: 'No matching pending date-change request found (likely a guest-count-only change).' };
  }

  if (!updateInfo.confirmationCode) {
    return { applied: false, reason: 'Update email had no confirmation code to apply changes to.' };
  }

  const updateResult = db.prepare(`
    UPDATE bookings SET check_in = ?, check_out = ?, updated_at = CURRENT_TIMESTAMP
    WHERE booking_number = ? AND status != 'cancelled'
  `).run(match.requested_check_in, match.requested_check_out, updateInfo.confirmationCode);

  db.prepare('DELETE FROM pending_airbnb_changes WHERE id = ?').run(match.id);

  if (updateResult.changes === 0) {
    return { applied: false, reason: 'Booking is already cancelled - date change request discarded.' };
  }

  return { applied: true, confirmationCode: updateInfo.confirmationCode };
}

// Used by airbnbChatReply.js's technical-issue staff alert to name the room a
// guest is actually in. Only reliably populated for guests currently checked
// in (assigned once daily, externally, ~evening before/morning of check-in) -
// callers must handle a null return (guest hasn't been assigned a room yet).
function findAssignedRoomByGuestAndDates(db, { guestName, checkIn, checkOut }) {
  const candidates = db
    .prepare(
      `SELECT guest_name, assigned_room FROM bookings
       WHERE platform = 'airbnb' AND status != 'cancelled' AND check_in = ? AND check_out = ?`
    )
    .all(checkIn, checkOut);
  const match = candidates.find(
    (c) => (c.guest_name || '').trim().toLowerCase() === (guestName || '').trim().toLowerCase()
  );
  return match ? match.assigned_room : null;
}

// A pending change request that's older than 72 hours can never be matched
// anymore (applyAirbnbUpdate only looks within that window), so it's safe to
// assume it was declined (or simply never approved) and clean it up automatically.
function cleanupExpiredAirbnbChanges(db) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 72);

  const expired = db
    .prepare('SELECT guest_name, room_number, requested_check_in, requested_check_out FROM pending_airbnb_changes WHERE detected_at < ?')
    .all(cutoff.toISOString());

  if (expired.length > 0) {
    db.prepare('DELETE FROM pending_airbnb_changes WHERE detected_at < ?').run(cutoff.toISOString());
  }

  return expired; // returned so the caller can log what was cleaned up
}

// ---------- CALENDAR SYNC ----------

function getInitials(guestName) {
  const words = (guestName || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return '??';
}

function daysBetweenIso(isoA, isoB) {
  const [ay, am, ad] = isoA.split('-').map(Number);
  const [by, bm, bd] = isoB.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Google Calendar all-day events use an exclusive end date (the day AFTER the event).
function nextDayIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function buildEventPrefix(booking) {
  const effectiveCategory = booking.room_override || booking.room_category;
  if (booking.platform === 'airbnb') {
    return `A #${booking.room_number || '??'}`;
  }
  if (booking.platform === 'booking.com') {
    if (effectiveCategory === 'Double Bedroom') return 'BD';
    if (effectiveCategory === 'Small Room') return 'BK';
    return 'B';
  }
  // offline / manual
  if (effectiveCategory === 'Double Bedroom') return 'FD';
  if (effectiveCategory === 'Small Room') return 'FK';
  return 'F';
}

function buildEventTitle(booking, dayNumber, totalNights) {
  const effectiveCategory = booking.room_override || booking.room_category;
  const prefix = buildEventPrefix(booking);
  const star = effectiveCategory === 'Double Bedroom' ? ' ⭐' : '';
  const initials = getInitials(booking.guest_name);
  const roomTag = booking.platform !== 'airbnb' && booking.room_number ? ` (${booking.room_number})` : '';
  return `${prefix}${star} ${initials}${roomTag} (Day ${dayNumber}/${totalNights})`;
}

function buildEventColor(booking) {
  // Platform-based only. Set once at event creation and never patched again
  // afterward, so any manual color changes (e.g. marking yellow for a
  // special note) made directly in Google Calendar are never overwritten.
  if (booking.platform === 'airbnb') return '11'; // Tomato (closer to Airbnb's real brand red/coral)
  return '9'; // Blueberry (blue) - used for Booking.com and offline
}

const TOTAL_CAPACITY = 21; // 11 Normal + 9 Double + 1 Small
const SUMMARY_MARKER = '__SUMMARY__';

// Computes the full set of calendar events that SHOULD exist right now,
// based purely on the current state of the bookings table.
function computeDesiredEvents(db) {
  const rows = db.prepare("SELECT * FROM bookings WHERE status != 'cancelled'").all();
  const desired = [];
  const nightlyTotals = {};

  for (const row of rows) {
    if (!row.check_in || !row.check_out) continue;
    const totalNights = daysBetweenIso(row.check_in, row.check_out);
    if (totalNights <= 0) continue;

    let night = row.check_in;
    for (let dayNumber = 1; dayNumber <= totalNights; dayNumber++) {
      desired.push({
        booking_number: row.booking_number,
        night_date: night,
        title: buildEventTitle(row, dayNumber, totalNights),
        color: buildEventColor(row),
      });
      nightlyTotals[night] = (nightlyTotals[night] || 0) + 1;
      night = nextDayIso(night);
    }
  }

  // One additional daily summary event per date, e.g. "19/21".
  for (const [date, count] of Object.entries(nightlyTotals)) {
    desired.push({
      booking_number: SUMMARY_MARKER,
      night_date: date,
      title: `${count}/${TOTAL_CAPACITY}`,
      color: null, // no color set/managed for the summary event
    });
  }

  return desired;
}

// Full reconciliation: compares desired state against what's tracked in
// calendar_sync, and creates/updates/deletes events as needed so the
// calendar always matches the database. Safe to run repeatedly.
async function reconcileCalendar(db, calendarAccount = 'airbnb') {
  const calendar = getCalendarClient(calendarAccount);
  const desired = computeDesiredEvents(db);
  const existing = db.prepare('SELECT * FROM calendar_sync').all();

  const desiredMap = new Map(desired.map((d) => [`${d.booking_number}|${d.night_date}`, d]));
  const existingMap = new Map(existing.map((e) => [`${e.booking_number}|${e.night_date}`, e]));

  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const [key, d] of desiredMap) {
    const e = existingMap.get(key);

    if (!e) {
      const requestBody = {
        summary: d.title,
        start: { date: d.night_date },
        end: { date: nextDayIso(d.night_date) },
      };
      if (d.color) requestBody.colorId = d.color;

      const event = await calendar.events.insert({ calendarId: 'primary', requestBody });
      db.prepare(`
        INSERT INTO calendar_sync (booking_number, night_date, event_id, last_title, last_color)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(booking_number, night_date) DO UPDATE SET
          event_id = excluded.event_id,
          last_title = excluded.last_title,
          last_color = excluded.last_color
      `).run(d.booking_number, d.night_date, event.data.id, d.title, d.color);
      created++;
      continue;
    }

    if (e.last_title !== d.title) {
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: e.event_id,
        requestBody: { summary: d.title }, // deliberately NOT patching colorId here
      });
      db.prepare(`
        UPDATE calendar_sync SET last_title = ? WHERE booking_number = ? AND night_date = ?
      `).run(d.title, d.booking_number, d.night_date);
      updated++;
    }
  }

  for (const [key, e] of existingMap) {
    if (!desiredMap.has(key)) {
      try {
        await calendar.events.delete({ calendarId: 'primary', eventId: e.event_id });
      } catch (err) {
        // Event may already be gone (e.g. manually deleted) - fine either way.
      }
      db.prepare('DELETE FROM calendar_sync WHERE booking_number = ? AND night_date = ?').run(
        e.booking_number,
        e.night_date
      );
      deleted++;
    }
  }

  return { created, updated, deleted, totalDesired: desired.length };
}

// ---------- DATA QUALITY CHECK ----------
// Catches bookings that are sitting in the DB with a 'correct-looking' status but
// actually-broken data inside (e.g. the Aug 2026 Airbnb year-rollover bug, or the
// Booking.com non-ASCII guest-name regex bug) - problems the normal detector cycle
// can't see, since it only checks "is this booking's status what we'd expect",
// never "is the data inside it actually sane". Cancelled bookings are excluded -
// missing/blank fields on a cancelled booking don't affect occupancy or invoices.
function checkDataQuality(db) {
  const rows = db
    .prepare(`SELECT * FROM bookings WHERE status != 'cancelled'`)
    .all();

  const issues = [];

  for (const b of rows) {
    const problems = [];

    if (!b.guest_name || !b.guest_name.trim()) {
      problems.push('Missing guest name');
    }

    if (!b.room_category || b.room_category === 'UNKNOWN') {
      problems.push('Missing/unknown room category');
    }

    if (!b.check_in || !b.check_out) {
      problems.push('Missing check-in or check-out date');
    } else if (b.check_out <= b.check_in) {
      // YYYY-MM-DD strings compare correctly with <= as plain strings - no Date
      // object involved, consistent with this project's date-handling convention.
      problems.push(`Check-out (${b.check_out}) is not after check-in (${b.check_in})`);
    }

    if (problems.length > 0) {
      issues.push({
        bookingNumber: b.booking_number,
        platform: b.platform,
        guestName: b.guest_name,
        checkIn: b.check_in,
        checkOut: b.check_out,
        roomCategory: b.room_category,
        status: b.status,
        updatedAt: b.updated_at,
        problems,
      });
    }
  }

  return issues;
}

// ---------- CHECKOUT REPORT (WhatsApp housekeeping message) ----------
// Pure integer date math, same convention as the rest of the project.
function checkoutReportNextIsoDay(iso) {
  const [y0, m0, d0] = iso.split('-').map((n) => parseInt(n, 10));
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  let y = y0, m = m0, d = d0 + 1;
  const dim = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
  if (d > dim) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const CHECKOUT_REPORT_GROUP_JID = '120363402060306853@g.us'; // "Boston Check In Out"
const STAFF_GROUP_JID = '120363405393193359@g.us'; // same group whatsapp-bot's config.staffGroupJid uses
const OUTBOX_DIR = 'C:\\apps\\shared-data\\wa-outbox';

// Shared with whatsapp-bot's gapCheck.js - it has no Gmail access of its own,
// so it drops a file here for detector.js's checkAndSendGapAlerts() to email out.
const GAP_ALERTS_DIR = 'C:\\apps\\shared-data\\gap-alerts';

// Builds the housekeeping WhatsApp message: tomorrow's check-outs by assigned
// room, any unassigned ones flagged so nothing's silently missed, and the
// day-after-tomorrow count for staffing/leave planning.
function composeCheckoutReport(db, todayIso) {
  const tomorrow = checkoutReportNextIsoDay(todayIso);
  const dayAfter = checkoutReportNextIsoDay(tomorrow);

  const tomorrowCheckouts = db
    .prepare(`SELECT booking_number, assigned_room FROM bookings WHERE status != 'cancelled' AND check_out = ?`)
    .all(tomorrow);

  const dayAfterCount = db
    .prepare(`SELECT COUNT(*) as c FROM bookings WHERE status != 'cancelled' AND check_out = ?`)
    .get(dayAfter).c;

  const assignedRooms = tomorrowCheckouts.filter((b) => b.assigned_room).map((b) => b.assigned_room);
  const unassigned = tomorrowCheckouts.filter((b) => !b.assigned_room);

  const lines = [];
  if (assignedRooms.length > 0) {
    lines.push('# ' + assignedRooms.join(', '));
  } else if (tomorrowCheckouts.length === 0) {
    lines.push('No check-outs tomorrow.');
  }
  unassigned.forEach((b) => {
    lines.push(`⚠ ${b.booking_number} not yet assigned - check dashboard`);
  });
  lines.push('Tolong bersih. Thank you 👍🙏');
  lines.push(`Lusa ${dayAfterCount} check out. (bot)`);

  return lines.join('\n');
}

// Drops a message for whatsapp-bot to pick up and send - the bot polls this
// folder on its own timer and has no idea what a "checkout report" even is,
// it just sends whatever {groupJid, message} it finds. Keeps the bot dumb and
// this feature entirely on the bookings side, per the agreed design.
//
// Filename is a generic "outbox-" prefix regardless of caller - it used to
// be hardcoded "checkout-report-" for every message (including ones with
// nothing to do with checkout reports), which made pm2 logs actively
// misleading when diagnosing what was actually sent.
function writeOutboxMessage(groupJid, message) {
  if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const filename = `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`;
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), JSON.stringify({ groupJid, message }), 'utf8');
  return filename;
}

module.exports = {
  getAuthClient,
  getGmailClient,
  getCalendarClient,
  reconcileCalendar,
  buildEventColor,
  listAllMessages,
  parseSubjectOnly,
  parseBody,
  buildBookingLink,
  extractBody,
  dedupe,
  openDb,
  isAlreadyScraped,
  saveCancelled,
  extractCancelledGuestName,
  saveBooking,
  saveMultiRoomBooking,
  parseMoney,
  parseAirbnbFinancials,
  saveFinancials,
  randomDelayMs,
  sleep,
  scrape,
  sendAlertEmail,
  sendThreadedReply,
  formatGmailDate,
  toLocalISODate,
  upsertPendingQueue,
  getPendingQueue,
  getPendingCount,
  markPendingFailed,
  removeFromPendingQueue,
  clearAllErrors,
  GAP_ALERTS_DIR,
  parseAirbnbNewBooking,
  parseAirbnbCancellation,
  parseAirbnbRiskCancellation,
  parseAirbnbChangeRequest,
  parseAirbnbUpdateConfirmed,
  saveAirbnbBooking,
  saveAirbnbCancellation,
  queueAirbnbChangeRequest,
  applyAirbnbUpdate,
  findAssignedRoomByGuestAndDates,
  cleanupExpiredAirbnbChanges,
  checkDataQuality,
  composeCheckoutReport,
  writeOutboxMessage,
  CHECKOUT_REPORT_GROUP_JID,
  STAFF_GROUP_JID,
};

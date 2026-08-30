/**
 * create-guest-passcode.js
 *
 * Called by the dashboard when staff clicks the "generate passcode" button
 * for a specific booking. Does three things only:
 *   1. Creates a temporary lock passcode (Tuya or TTLock, whichever the
 *      unit uses) for the buffered check-in/out window.
 *   2. Builds the guest-passcode WhatsApp message from the template.
 *   3. Drops it into the whatsapp-bot's outbox folder to be sent.
 *
 * Does NOT touch bookings.db, does NOT build any UI, does NOT handle
 * deleting/expiring old codes. Scope is deliberately limited to this one
 * button's action - see LOGIC_whatsappbot.md for the rest of the system.
 *
 * Follows the project convention: no `Date` object timezone conversion
 * anywhere. Dates in are always "YYYY-MM-DD" strings.
 */

const fs = require('fs');
const path = require('path');
const devices = require('./devices.json');

const tuyaLib = require('./tuya-lib.js');   // from tuya-lock-final/lib.js
const ttlockLib = require('./ttlock-lib.js'); // from ttlock-final/lib.js

// ---- Collision avoidance ledger ----
// Since this script is the sole source of passcodes for these locks, we
// track every code we've issued locally (per lock, with its validity
// window) and check for real overlapping collisions before creating a new
// one. This avoids relying on Tuya's encrypted temp-password list format,
// which can't be reliably compared against plaintext without extra
// decryption work of uncertain reliability.
const LEDGER_PATH = path.join(__dirname, 'issued-codes.json');
const MAX_GENERATION_ATTEMPTS = 20;

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch (e) {
    return []; // corrupted/empty file - start fresh rather than crash
  }
}

function saveLedger(entries) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2));
}

/** Two time windows overlap if one starts before the other ends, both ways. */
function windowsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

/**
 * Generates a 7-digit code guaranteed not to collide with any code this
 * script has already issued to the SAME lock during an OVERLAPPING time
 * window. Codes on different locks, or non-overlapping windows on the same
 * lock, are allowed to repeat - that's not an actual conflict.
 */
function generateNonCollidingCode(unit, effectiveMs, invalidMs, ledger) {
  const sameLockOverlapping = ledger.filter(
    (e) => e.unit === unit && windowsOverlap(effectiveMs, invalidMs, e.effectiveMs, e.invalidMs)
  );
  const takenCodes = new Set(sameLockOverlapping.map((e) => e.passcode));

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const code = generateRandom7DigitCode();
    if (!takenCodes.has(code)) return code;
  }
  throw new Error(
    `Could not generate a non-colliding passcode for ${unit} after ${MAX_GENERATION_ATTEMPTS} attempts - ` +
    `unusually high number of overlapping active codes on this lock, worth checking manually.`
  );
}

// ---- Config - adjust to match your actual deployment paths ----
const OUTBOX_DIR = process.env.OUTBOX_DIR || 'C:\\apps\\shared-data\\wa-outbox';
const GUEST_PASSCODE_GROUP_JID = process.env.GUEST_PASSCODE_GROUP_JID || '120363423906108997@g.us';

// Actual passcode validity: 2:00 PM check-in day -> 12:00 PM check-out day (hidden buffer)
const CHECKIN_BUFFER_HOUR = 14;
const CHECKOUT_BUFFER_HOUR = 12;

// What the WhatsApp message DISPLAYS to the guest - official policy times,
// deliberately NOT the same as the buffer above. The buffer is a silent
// goodwill margin, never advertised, so guests don't start expecting it.
const DISPLAY_CHECKIN_HOUR = 15; // 3:00 PM
const DISPLAY_CHECKOUT_HOUR = 11; // 11:00 AM

// Malaysia is fixed UTC+8, no DST - safe to hardcode
const MALAYSIA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Converts a "YYYY-MM-DD" date string + a local hour into a true UTC
 * unix-ms timestamp, WITHOUT going through `new Date(string)` (which is
 * ambiguous/locale-dependent) or `.toISOString()` (which caused the
 * timezone bugs documented in LOGIC_whatsappbot.md). Pure integer math only.
 */
function isoDateToUnixMs(isoDateStr, localHour, localMinute = 0) {
  const [year, month, day] = isoDateStr.split('-').map(Number);
  const utcMsIfItWereUtc = Date.UTC(year, month - 1, day, localHour, localMinute, 0);
  return utcMsIfItWereUtc - MALAYSIA_UTC_OFFSET_MS;
}

/** Generates a random 7-digit code (required by both lock systems), avoiding obvious patterns. */
function generateRandom7DigitCode() {
  const obviousPatterns = ['0000000', '1111111', '1234567', '7654321', '1212121'];
  let code;
  do {
    code = Math.floor(1000000 + Math.random() * 9000000).toString();
  } while (obviousPatterns.includes(code));
  return code;
}

/**
 * Formats a unix-ms timestamp back into a human-readable Malaysia local
 * time string for the WhatsApp message, again without Date-object
 * timezone ambiguity - manually applies the fixed UTC+8 offset.
 */
function formatMalaysiaTime(unixMs) {
  const shifted = new Date(unixMs + MALAYSIA_UTC_OFFSET_MS);
  const hours24 = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minuteStr = minutes.toString().padStart(2, '0');
  return `${hours12}:${minuteStr}${ampm}`;
}

/**
 * Builds the WhatsApp message text, matching the confirmed real template.
 * The leading * before the passcode is a literal keypad instruction (press
 * * to clear any accidental input first), not WhatsApp bold formatting -
 * confirmed with the user, not a typo.
 */
function buildMessage({ unit, location, driveLink, guestName, passcode, checkInDate, checkOutDate }) {
  const checkInTimeStr = formatMalaysiaTime(isoDateToUnixMs(checkInDate, DISPLAY_CHECKIN_HOUR));
  const checkOutTimeStr = formatMalaysiaTime(isoDateToUnixMs(checkOutDate, DISPLAY_CHECKOUT_HOUR));

  return [
    `Hi ${guestName},`,
    ``,
    `📍 ${location}`,
    `🔑 Passcode: *${passcode}#`,
    ``,
    `Valid: ${checkInTimeStr}, ${formatDisplayDate(checkInDate)} – ${checkOutTimeStr}, ${formatDisplayDate(checkOutDate)}`,
    ``,
    `QR code: ${driveLink}`,
    ``,
    `⚠️ Do not use the fingerprint scanner`,
    `⚠️ Wrong code? Press *** to clear, then retry`,
    `⚠️ 3 failed attempts, wait 5 min, retry`,
  ].join('\n');
}

/** "2026-08-05" -> "5 August 2026", pure string/integer math, no Date-object timezone risk. */
function formatDisplayDate(isoDateStr) {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [year, month, day] = isoDateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** Writes the message into the shared outbox folder for whatsapp-bot to pick up and send. */
function sendToWhatsAppOutbox(message) {
  if (!fs.existsSync(OUTBOX_DIR)) {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  }
  const filename = `passcode-${Date.now()}.json`;
  const filePath = path.join(OUTBOX_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify({
    groupJid: GUEST_PASSCODE_GROUP_JID,
    message,
  }));
  return filePath;
}

/**
 * Main entry point. Call this from the dashboard's button handler.
 * @param {string} unit - physical room code, e.g. "S1503" (matches assigned_room format)
 * @param {string} guestName
 * @param {string} checkInDate - "YYYY-MM-DD"
 * @param {string} checkOutDate - "YYYY-MM-DD"
 * @returns {object} result summary - also useful for logging/debugging in the dashboard
 */
async function createGuestPasscode(unit, guestName, checkInDate, checkOutDate) {
  const device = devices.units.find((d) => d.unit === unit);
  if (!device) {
    throw new Error(`No lock configured for unit "${unit}" - check devices.json`);
  }

  const ledger = loadLedger();
  const effectiveMs = isoDateToUnixMs(checkInDate, CHECKIN_BUFFER_HOUR);
  const invalidMs = isoDateToUnixMs(checkOutDate, CHECKOUT_BUFFER_HOUR);
  const passcode = generateNonCollidingCode(unit, effectiveMs, invalidMs, ledger);

  let lockResult;
  if (device.system === 'tuya') {
    lockResult = await tuyaLib.createTempPassword(device.lock_device_id, {
      name: `Guest - ${guestName}`,
      password: passcode,
      effectiveTime: Math.floor(effectiveMs / 1000), // Tuya wants unix seconds
      invalidTime: Math.floor(invalidMs / 1000),
    });
    if (!lockResult.success) {
      throw new Error(`Tuya passcode creation failed: ${JSON.stringify(lockResult)}`);
    }
  } else if (device.system === 'ttlock') {
    const accessToken = await ttlockLib.getAccessToken();
    lockResult = await ttlockLib.createTempPasscode(accessToken, device.lock_id, {
      name: `Guest - ${guestName}`,
      passcode,
      startTime: effectiveMs, // TTLock wants unix milliseconds
      endTime: invalidMs,
    });
    if (!lockResult.keyboardPwdId) {
      throw new Error(`TTLock passcode creation failed: ${JSON.stringify(lockResult)}`);
    }
  } else {
    throw new Error(`Unknown system "${device.system}" for unit "${unit}"`);
  }

  ledger.push({ unit, passcode, effectiveMs, invalidMs, guestName, issuedAt: Date.now() });
  saveLedger(ledger);

  const message = buildMessage({
    unit,
    location: device.location,
    driveLink: devices.driveLinks[unit.slice(0, 3)] || 'LINK NOT FOUND - check devices.json driveLinks',
    guestName,
    passcode,
    checkInDate,
    checkOutDate,
  });
  const outboxFile = sendToWhatsAppOutbox(message);

  return {
    unit,
    guestName,
    passcode,
    system: device.system,
    effectiveTime: effectiveMs,
    invalidTime: invalidMs,
    lockResult,
    whatsappMessage: message,
    outboxFile,
  };
}

module.exports = { createGuestPasscode };

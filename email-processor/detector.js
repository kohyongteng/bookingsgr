process.chdir(__dirname); // ensure relative paths (credentials.json, token.json) resolve correctly under pm2

const lib = require('./lib');
const fs = require('fs');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CHECKOUT_REPORT_HOUR = 21; // 9 PM local time
const CHECKOUT_REPORT_LAST_SENT_PATH = './checkout_report_last_sent.json';
const DATA_QUALITY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours - separate, slower timer
const LAST_CHECK_PATH = './detector_last_check.json';
const AIRBNB_LAST_CHECK_PATH = './detector_airbnb_last_check.json';
const ADMIN_EMAIL = 'teng20240301@gmail.com'; // change if needed - same address sync-service.js alerts to

function getLastCheckDate(filePath) {
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new Date(data.lastCheck);
  }
  const d = new Date();
  d.setDate(d.getDate() - 1); // first run: look back 1 day to be safe
  return d;
}

function saveLastCheckDate(filePath, date) {
  fs.writeFileSync(filePath, JSON.stringify({ lastCheck: date.toISOString() }, null, 2));
}

// ---------- Auth-failure monitor (catches expired/revoked tokens on both accounts) ----------
const AUTH_ALERT_STATE_PATH = './auth_alert_last_sent.json';
const AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours - don't re-alert every 5 min if left broken

function isAuthError(err) {
  const msg = (err && err.message) || '';
  return (
    msg.includes('invalid_grant') ||
    msg.includes('invalid_token') ||
    msg.includes('unauthorized_client') ||
    msg.includes('Token has been expired or revoked')
  );
}

async function alertAuthFailure(account, err) {
  const state = fs.existsSync(AUTH_ALERT_STATE_PATH)
    ? JSON.parse(fs.readFileSync(AUTH_ALERT_STATE_PATH, 'utf8'))
    : {};
  const lastSent = state[account] ? new Date(state[account]) : null;
  const now = new Date();

  if (lastSent && now - lastSent < AUTH_ALERT_COOLDOWN_MS) {
    return; // already alerted recently for this account - avoid spamming every cycle
  }

  const subject = `Gmail/Calendar authorization expired: ${account}`;
  const body =
    `The "${account}" Google account's token has expired or been revoked ` +
    `(invalid_grant). That account can't be checked until re-authorized - ` +
    `bookings/calendar events on it are NOT being picked up right now.\n\n` +
    `Error: ${err.message}\n\n` +
    `To fix, on the mini PC (or via SSH port-forward from your Mac):\n` +
    `  cd C:\\apps\\email-processor\n` +
    `  node authorize.js --account=${account}\n\n` +
    `Then open the printed URL and log in with the correct Google account.\n\n` +
    `This alert repeats at most once every ${AUTH_ALERT_COOLDOWN_MS / (60 * 60 * 1000)} hours until fixed.`;

  // Try the OTHER account first if this account is the one that broke -
  // sending through the broken account itself is exactly what fails
  // silently. Fall back to the same account only if there's no other option.
  const sendOrder = account === 'airbnb' ? ['default', 'airbnb'] : ['airbnb', 'default'];
  let sent = false;

  for (const sendAs of sendOrder) {
    try {
      const gmail = sendAs === 'default' ? lib.getGmailClient() : lib.getGmailClient('airbnb');
      await lib.sendAlertEmail(gmail, ADMIN_EMAIL, subject, body);
      console.log(`  Sent auth-failure alert email for account "${account}" (via ${sendAs} account).`);
      sent = true;
      break;
    } catch (alertErr) {
      console.error(`  Failed to send auth-failure alert via ${sendAs} account:`, alertErr.message);
    }
  }

  if (!sent) {
    console.error(
      `  BOTH accounts failed to send the alert - both tokens are likely broken simultaneously. ` +
      `Check pm2 logs directly, no email will arrive.`
    );
  }

  state[account] = now.toISOString();
  fs.writeFileSync(AUTH_ALERT_STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- Booking.com cycle (writes to pending_queue, needs Sync Now / login) ----------
async function runBookingComCycle() {
  const now = new Date();
  console.log(`[${now.toISOString()}] Booking.com detector cycle starting...`);

  try {
    const gmail = lib.getGmailClient();
    const db = lib.openDb();

    const lastCheck = getLastCheckDate(LAST_CHECK_PATH);
    const searchFrom = new Date(lastCheck);
    searchFrom.setDate(searchFrom.getDate() - 1);
    const afterDate = lib.formatGmailDate(searchFrom);

    const query = `from:booking.com subject:"booking" after:${afterDate}`;
    const messages = (await lib.listAllMessages(gmail, query)).reverse();
    // .reverse(): Gmail returns newest-first by default. Processing oldest-to-newest
    // matters because upsertPendingQueue()/saveBooking() always let the LAST-seen
    // email win for a given booking number - if we processed newest-first, an older
    // email for the same booking (still inside the rolling search window) would be
    // seen LAST and would wrongly overwrite the real, newer state. This is what
    // caused bookings to flip-flop / keep reappearing in the pending queue.

    let inserted = 0;
    let updated = 0;
    let alreadySynced = 0;
    let touched = 0;
    let cancelled = 0;

    for (const m of messages) {
      const meta = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject'],
      });
      const candidate = lib.parseSubjectOnly(meta.data, new Date('2000-01-01'));
      if (!candidate) continue;

      if (candidate.type === 'CANCELLED') {
        // No scraping/login needed for cancellations - just the guest name from the
        // email body itself - so this can apply immediately instead of waiting on a
        // manual Sync Now. This also means a book-then-cancel-minutes-later guest
        // never needs to be scraped at all.
        let guestName = null;
        try {
          const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
          const { text } = lib.extractBody(full.data.payload);
          guestName = lib.extractCancelledGuestName(text);
        } catch (err) {
          // Non-fatal - proceed without guest name if this lookup fails.
        }
        lib.saveCancelled(db, { bookingNumber: candidate.bookingNumber, guestName });
        // Clear any leftover pending-sync entry for this booking - a cancelled
        // booking never needs scraping, so it shouldn't sit around as "1 pending".
        lib.removeFromPendingQueue(db, candidate.bookingNumber);
        cancelled++;
        continue;
      }

      const result = lib.upsertPendingQueue(db, { ...candidate, gmailMessageId: m.id });
      if (result === 'inserted') inserted++;
      else if (result === 'updated-type-changed') updated++;
      else if (result === 'already-synced') alreadySynced++;
      else if (result === 'touched') touched++;
    }

    db.close();
    saveLastCheckDate(LAST_CHECK_PATH, now);

    console.log(
      `[${now.toISOString()}] Booking.com cycle done. Checked ${messages.length} emails. ` +
      `New: ${inserted}, Status-changed: ${updated}, Already synced: ${alreadySynced}, ` +
      `Unchanged: ${touched}, Auto-cancelled: ${cancelled}`
    );
  } catch (err) {
    console.error(`[${now.toISOString()}] Booking.com cycle error:`, err.message);
    if (isAuthError(err)) await alertAuthFailure('default', err);
  }
}

// ---------- Airbnb cycle (writes directly to bookings.db - no login risk, no queue needed) ----------
async function runAirbnbCycle() {
  const now = new Date();
  console.log(`[${now.toISOString()}] Airbnb detector cycle starting...`);

  try {
    const gmail = lib.getGmailClient('airbnb');
    const db = lib.openDb();

    const lastCheck = getLastCheckDate(AIRBNB_LAST_CHECK_PATH);
    const searchFrom = new Date(lastCheck);
    searchFrom.setDate(searchFrom.getDate() - 1);
    const afterDate = lib.formatGmailDate(searchFrom);

    // Catch all 4 email types in one search
    const query = `after:${afterDate} (subject:"Reservation confirmed" OR subject:"Canceled: Reservation" OR subject:"wants to change their reservation" OR subject:"Reservation updated")`;
    const messages = (await lib.listAllMessages(gmail, query)).reverse();
    // .reverse(): see the comment in runBookingComCycle - same reasoning applies here,
    // e.g. a cancellation and an older still-in-window booking email for the same
    // confirmation code must be applied oldest-first so the cancellation always wins.

    let newCount = 0;
    let cancelledCount = 0;
    let changeQueuedCount = 0;
    let changeIgnoredCount = 0;
    let updateAppliedCount = 0;
    let updateNoMatchCount = 0;

    for (const m of messages) {
      const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = full.data.payload.headers;
      const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '';
      const receivedDate = full.data.internalDate
        ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
        : now.toISOString();
      const { text } = lib.extractBody(full.data.payload);

      if (subject.startsWith('Reservation confirmed')) {
        const parsed = lib.parseAirbnbNewBooking(subject, text, receivedDate);
        if (parsed && parsed.confirmationCode) {
          lib.saveAirbnbBooking(db, parsed);
          newCount++;
        }
        continue;
      }

      if (subject.startsWith('Canceled: Reservation')) {
        const parsed = lib.parseAirbnbCancellation(subject);
        if (parsed) {
          lib.saveAirbnbCancellation(db, parsed.confirmationCode);
          cancelledCount++;
        }
        continue;
      }

      if (subject.includes('wants to change their reservation')) {
        const parsed = lib.parseAirbnbChangeRequest(subject, text, receivedDate);
        if (parsed && parsed.type === 'CHANGE_REQUEST_DATES') {
          if (!parsed.roomNumber) {
            console.log(`  WARNING: could not extract room number for "${subject}" - skipping, needs manual check.`);
            changeIgnoredCount++;
          } else {
            lib.queueAirbnbChangeRequest(db, parsed);
            changeQueuedCount++;
          }
        } else {
          changeIgnoredCount++;
        }
        continue;
      }

      if (subject === 'Reservation updated') {
        const parsed = lib.parseAirbnbUpdateConfirmed(text);
        if (parsed) {
          const result = lib.applyAirbnbUpdate(db, parsed);
          if (result.applied) updateAppliedCount++;
          else updateNoMatchCount++;
        }
        continue;
      }
    }

    // Any pending change request older than 72 hours can never be matched
    // anymore - assume it was declined and clean it up automatically.
    const expired = lib.cleanupExpiredAirbnbChanges(db);
    if (expired.length > 0) {
      console.log(`  Auto-removed ${expired.length} expired (assumed-declined) change request(s):`);
      expired.forEach((e) =>
        console.log(`    ${e.guest_name} | #${e.room_number} | requested: ${e.requested_check_in} - ${e.requested_check_out}`)
      );
    }

    db.close();
    saveLastCheckDate(AIRBNB_LAST_CHECK_PATH, now);

    console.log(
      `[${now.toISOString()}] Airbnb cycle done. Checked ${messages.length} emails. ` +
      `New: ${newCount}, Cancelled: ${cancelledCount}, Change queued: ${changeQueuedCount}, ` +
      `Change ignored (guest-count only): ${changeIgnoredCount}, Update applied: ${updateAppliedCount}, ` +
      `Update no-match: ${updateNoMatchCount}`
    );
  } catch (err) {
    console.error(`[${now.toISOString()}] Airbnb cycle error:`, err.message);
    if (isAuthError(err)) await alertAuthFailure('airbnb', err);
  }
}

async function runCalendarSyncCycle() {
  const now = new Date();
  console.log(`[${now.toISOString()}] Calendar sync cycle starting...`);
  try {
    const db = lib.openDb();
    const result = await lib.reconcileCalendar(db, 'airbnb');
    db.close();
    console.log(
      `[${now.toISOString()}] Calendar sync done. Created: ${result.created}, Updated: ${result.updated}, ` +
      `Deleted: ${result.deleted}, Total events tracked: ${result.totalDesired}`
    );
  } catch (err) {
    console.error(`[${now.toISOString()}] Calendar sync error:`, err.message);
    if (isAuthError(err)) await alertAuthFailure('airbnb', err);
  }
}

async function runAllCycles() {
  await runBookingComCycle();
  await runAirbnbCycle();
  await runCalendarSyncCycle();
}

// ---------- Data quality check (separate 6-hour timer, not part of the 5-min cycle) ----------
// Catches bad data already sitting in the DB (missing guest name, bad dates, etc.) -
// a different problem than "missing pickup", so it needs its own scan of bookings.db
// rather than re-scanning Gmail. Runs independently of the 5-minute loop so it can't
// spam an email every 5 minutes for an issue nobody's fixed yet.
async function runDataQualityCheck() {
  const now = new Date();
  console.log(`[${now.toISOString()}] Data quality check starting...`);

  try {
    const db = lib.openDb();
    const allIssues = lib.checkDataQuality(db);
    db.close();

    // Only alert on issues that are still operationally relevant: the stay hasn't
    // fully finished (check-out today or later), or the booking row was touched
    // recently (last 7 days) so it's clearly a NEW problem worth flagging right
    // away even if its dates happen to be corrupted/missing. This deliberately
    // excludes old, already-checked-out bookings sitting in the historical
    // backlog - alerting on those every 6 hours forever would just be noise.
    const today = lib.toLocalISODate(now);
    const recentCutoff = new Date(now);
    recentCutoff.setDate(recentCutoff.getDate() - 7);

    const issues = allIssues.filter((i) => {
      // A real check-out date, even from a corrupted row, is a far more reliable
      // signal than "when was this row last written" - a bulk historical backfill
      // can touch hundreds of old rows in one shot, making them all look "recent"
      // by updated_at alone for days afterward even though nothing about the
      // actual booking is new. Only fall back to updated_at when there's truly no
      // date to check against (the "missing dates entirely" case).
      if (i.checkOut) return i.checkOut >= today;
      if (i.updatedAt) return new Date(i.updatedAt) >= recentCutoff;
      return false;
    });

    if (issues.length === 0) {
      console.log(
        `[${now.toISOString()}] Data quality check done. ${allIssues.length} historical issue(s) ignored, none current/recent.`
      );
      return;
    }

    console.log(`[${now.toISOString()}] Data quality check done. ${issues.length} booking(s) with issues:`);
    issues.forEach((i) => console.log(`  ${i.bookingNumber} (${i.platform}): ${i.problems.join('; ')}`));

    const lines = issues.map(
      (i) =>
        `${i.bookingNumber} (${i.platform}) - ${i.guestName || '(no name)'} - ` +
        `${i.checkIn || '?'} to ${i.checkOut || '?'} - ${i.roomCategory || '(no category)'}\n` +
        `  Problem(s): ${i.problems.join('; ')}`
    );

    const body =
      `${issues.length} booking(s) in the system have data that needs a manual check:\n\n` +
      lines.join('\n\n') +
      `\n\nOpen the dashboard to review and fix these. This is a repeating reminder every ` +
      `${DATA_QUALITY_INTERVAL_MS / (60 * 60 * 1000)} hours until fixed.`;

    const gmail = lib.getGmailClient();
    await lib.sendAlertEmail(gmail, ADMIN_EMAIL, `Data quality check: ${issues.length} booking(s) need attention`, body);
  } catch (err) {
    console.error(`[${now.toISOString()}] Data quality check error:`, err.message);
  }
}

// ---------- Checkout report (9PM daily, auto-sent to housekeeping via whatsapp-bot's outbox) ----------
function getCheckoutReportLastSentDate() {
  if (fs.existsSync(CHECKOUT_REPORT_LAST_SENT_PATH)) {
    return JSON.parse(fs.readFileSync(CHECKOUT_REPORT_LAST_SENT_PATH, 'utf8')).date;
  }
  return null;
}
function saveCheckoutReportLastSentDate(dateIso) {
  fs.writeFileSync(CHECKOUT_REPORT_LAST_SENT_PATH, JSON.stringify({ date: dateIso }));
}

async function checkAndSendCheckoutReportIfDue() {
  const now = new Date();
  if (now.getHours() !== CHECKOUT_REPORT_HOUR) return; // only fire during the 9PM hour

  const todayIso = lib.toLocalISODate(now);
  // Persisted (not just an in-memory flag) so a pm2 restart during the 9PM
  // hour can never cause a duplicate send.
  if (getCheckoutReportLastSentDate() === todayIso) return;

  try {
    const db = lib.openDb();
    const message = lib.composeCheckoutReport(db, todayIso);
    lib.writeOutboxMessage(lib.CHECKOUT_REPORT_GROUP_JID, message);
    db.close();
    saveCheckoutReportLastSentDate(todayIso);
    console.log(`[${now.toISOString()}] Checkout report auto-sent for ${todayIso}.`);
  } catch (err) {
    console.error(`[${now.toISOString()}] Checkout report error:`, err.message);
  }
}

console.log(`Detector starting. Will check every ${POLL_INTERVAL_MS / 60000} minutes.`);
runAllCycles();
setInterval(runAllCycles, POLL_INTERVAL_MS);

console.log(`Data quality check starting. Will check every ${DATA_QUALITY_INTERVAL_MS / (60 * 60 * 1000)} hours.`);
runDataQualityCheck();
setInterval(runDataQualityCheck, DATA_QUALITY_INTERVAL_MS);

console.log(`Checkout report timer starting. Will check every ${POLL_INTERVAL_MS / 60000} minutes, sends once during the ${CHECKOUT_REPORT_HOUR}:00 hour.`);
setInterval(checkAndSendCheckoutReportIfDue, POLL_INTERVAL_MS);

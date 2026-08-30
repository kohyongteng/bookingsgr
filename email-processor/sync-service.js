const lib = require('./lib');

const ADMIN_EMAIL = 'teng20240301@gmail.com'; // change if needed

const syncState = {
  running: false,
  total: 0,
  processed: 0,
  currentBooking: null,
  blocked: false,
  blockedMessage: null,
};

function getSyncState() {
  return { ...syncState };
}

async function runSync() {
  if (syncState.running) {
    return { started: false, reason: 'already-running' };
  }

  syncState.running = true;
  syncState.blocked = false;
  syncState.blockedMessage = null;
  syncState.processed = 0;

  (async () => {
    const db = lib.openDb();
    const items = db
      .prepare("SELECT * FROM pending_queue WHERE status = 'pending' ORDER BY email_received_at ASC")
      .all();

    syncState.total = items.length;

    for (const item of items) {
      syncState.currentBooking = item.booking_number;

      if (item.type === 'CANCELLED') {
        let guestName = null;
        try {
          const gmail = lib.getGmailClient();
          if (item.gmail_message_id) {
            const full = await gmail.users.messages.get({
              userId: 'me',
              id: item.gmail_message_id,
              format: 'full',
            });
            const { text } = lib.extractBody(full.data.payload);
            const guestMatch = text.match(/Reservation \d+ for (.+?) has been/);
            guestName = guestMatch ? guestMatch[1].trim() : null;
          }
        } catch (err) {
          // Non-fatal - proceed without guest name if this lookup fails.
        }

        lib.saveCancelled(db, { bookingNumber: item.booking_number, guestName });
        lib.removeFromPendingQueue(db, item.booking_number);
        syncState.processed++;
        continue;
      }

      await lib.sleep(lib.randomDelayMs());

      const bookingLink = lib.buildBookingLink(item.booking_number);
      let result;
      try {
        result = await lib.scrape(bookingLink);
      } catch (err) {
        lib.markPendingFailed(db, item.booking_number, `Scrape request error: ${err.message}`);
        syncState.processed++;
        continue;
      }

      if (result.status === 'BLOCKED' || result.status === 'LOGIN_REQUIRED') {
        lib.markPendingFailed(db, item.booking_number, result.message || result.status);
        syncState.blocked = true;
        syncState.blockedMessage = result.message || result.status;

        try {
          const gmail = lib.getGmailClient();
          await lib.sendAlertEmail(
            gmail,
            ADMIN_EMAIL,
            `Booking sync stopped: ${result.status}`,
            `${result.message}\n\nStopped at booking ${item.booking_number}.\n` +
            `Please log in to the Chrome window on the mini PC, then use "Clear Error" in the dashboard to resume.`
          );
        } catch (err) {
          // Non-fatal if alert email fails to send.
        }

        break;
      }

      if (result.status !== 'OK') {
        lib.markPendingFailed(db, item.booking_number, `Unexpected scrape result: ${JSON.stringify(result)}`);
        syncState.processed++;
        continue;
      }

      const status = item.type === 'MODIFIED' ? 'modified' : 'new';
      if (result.multiRoom) {
        lib.saveMultiRoomBooking(db, item.booking_number, status, result);
      } else {
        lib.saveBooking(db, item.booking_number, status, result);
      }
      lib.removeFromPendingQueue(db, item.booking_number);
      syncState.processed++;
    }

    db.close();
    syncState.running = false;
    syncState.currentBooking = null;
  })().catch((err) => {
    syncState.running = false;
    syncState.blocked = true;
    syncState.blockedMessage = `Unexpected sync error: ${err.message}`;
  });

  return { started: true };
}

module.exports = { runSync, getSyncState };

import fs from 'fs';
import path from 'path';
import { createSender } from './sender.js';
import { config } from './config.js';

// Polls a shared folder for message-send requests dropped there by the
// bookings-dashboard/email-processor side (a different Node process with no
// access to this bot's live WhatsApp connection). Each file is a small JSON
// blob: { groupJid, message }. Sent via the same sender everything else in
// this bot uses, then deleted. No new port, no new dependency - just a
// folder both processes can read/write. This is the ONLY thing this bot
// knows about the checkout-report feature - it stays otherwise unaware of
// bookings entirely, per the agreed design.

let currentSender = null;
let watcherRunning = false;

async function processOutbox() {
  if (!currentSender) return;

  let files;
  try {
    files = fs.readdirSync(config.outboxDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return; // folder doesn't exist yet - nothing to do
    console.error('[outboxWatcher] error reading outbox dir:', err);
    return;
  }

  for (const file of files) {
    const filePath = path.join(config.outboxDir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`[outboxWatcher] malformed file ${file}, removing:`, err.message);
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }

    const { groupJid, message } = parsed;
    if (!groupJid || !message) {
      console.error(`[outboxWatcher] skipping ${file} - missing groupJid/message`);
      try { fs.unlinkSync(filePath); } catch {}
      continue;
    }

    try {
      await currentSender.sendStaffText(groupJid, message);
      fs.unlinkSync(filePath);
      console.log(`[outboxWatcher] sent and removed ${file}`);
    } catch (err) {
      // Leave the file in place so it's retried next cycle (e.g. a transient
      // send error) - only parse/validation failures above get deleted outright.
      console.error(`[outboxWatcher] failed to send ${file}, will retry next cycle:`, err.message);
    }
  }
}

// Safe to call on every (re)connection - updates which socket to send through,
// but only starts the polling loop once ever, so a reconnect never creates a
// second overlapping interval.
export function startOutboxWatcher(sock) {
  currentSender = createSender(sock);
  if (watcherRunning) return;
  watcherRunning = true;

  setInterval(processOutbox, config.outboxPollMs);
  console.log(`[outboxWatcher] watching ${config.outboxDir} every ${config.outboxPollMs / 1000}s`);
}

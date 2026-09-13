// Guests who have been asked to confirm luggage storage but haven't answered.
//
// Why persisted to disk: this bot restarts often (deploys, reconnects), and
// the previous in-memory setTimeout version lost every pending flag on each
// restart. A guest who replied "Yes" after a restart therefore fell through to
// the intent classifier, which - seeing a bare affirmative with no context -
// answered "You're most welcome!" instead of sending the storeroom details.
// That is the same failure the Airbnb side had; see
// email-processor/airbnbChatReply.js for the other half of this fix.
//
// Expiry is evaluated on READ rather than by a timer. That is what makes a
// restart harmless: there is no timer to lose, only a stored timestamp.
//
// Entries are keyed by JID alias. The handler stores under EVERY known alias
// for a chat, so a restart that has forgotten its in-memory alias map still
// matches on whichever JID form the next message happens to arrive as.

import fs from 'fs';
import path from 'path';

const STORE_PATH = 'C:\\apps\\shared-data\\whatsapp-luggage-pending.json';
const WINDOW_MS = 24 * 60 * 60 * 1000;

let pending = new Map(); // alias key -> epoch ms when the confirm-ask was sent
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (raw && raw.pending && typeof raw.pending === 'object') {
        pending = new Map(
          Object.entries(raw.pending).filter(([, t]) => typeof t === 'number')
        );
      }
    }
  } catch (err) {
    // A corrupt/unreadable store must not take the bot down. Starting empty is
    // the safe failure mode: at worst a "Yes" is classified normally, which is
    // exactly the old behaviour - whereas throwing here would stop messages
    // being handled at all.
    console.error('[luggagePending] could not read store, starting empty:', err.message);
    pending = new Map();
  }
}

/** Drops entries past the window, so the file can't grow without bound. */
function prune(nowMs) {
  for (const [k, t] of pending) {
    if (nowMs - t > WINDOW_MS) pending.delete(k);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ pending: Object.fromEntries(pending) }, null, 2)
    );
  } catch (err) {
    console.error('[luggagePending] could not write store:', err.message);
  }
}

/** Records that these alias keys were just asked to confirm luggage storage. */
export function markLuggagePending(keys, nowMs = Date.now()) {
  load();
  prune(nowMs);
  for (const k of keys) pending.set(k, nowMs);
  persist();
}

/** Clears the flag for these alias keys (they confirmed, or we gave up). */
export function clearLuggagePending(keys, nowMs = Date.now()) {
  load();
  prune(nowMs);
  let changed = false;
  for (const k of keys) {
    if (pending.delete(k)) changed = true;
  }
  if (changed) persist();
}

/** Is any of these alias keys still within the 24h confirmation window? */
export function isLuggagePending(keys, nowMs = Date.now()) {
  load();
  return keys.some((k) => {
    const t = pending.get(k);
    return typeof t === 'number' && nowMs - t <= WINDOW_MS;
  });
}

/** Number of live (unexpired) entries - for tests and diagnostics. */
export function pendingCount(nowMs = Date.now()) {
  load();
  let n = 0;
  for (const [, t] of pending) {
    if (nowMs - t <= WINDOW_MS) n++;
  }
  return n;
}

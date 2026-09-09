// Tracks which guest chats we've already seen, so the welcome message is sent
// only on a guest's genuine FIRST contact and never again.
//
// Why persisted to disk: the bot restarts often (deploys, reconnects), and an
// in-memory set would forget everyone on every restart - re-welcoming guests
// mid-stay, which is exactly the behaviour this is meant to prevent.
//
// A JID is recorded on ANY first message, not just a greeting. If someone's
// opening message is an ID photo or "what's the wifi?", they are still a known
// contact afterwards, so a later "hi" won't be mistaken for first contact.

import fs from 'fs';
import path from 'path';

const STORE_PATH = 'C:\\apps\\shared-data\\whatsapp-known-guests.json';

let known = new Set();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (Array.isArray(raw.jids)) known = new Set(raw.jids);
    }
  } catch (err) {
    // A corrupt/unreadable store must not take the bot down. Starting empty
    // is the safe failure mode: at worst a guest gets one extra welcome,
    // whereas throwing here would stop messages being handled at all.
    console.error('[knownGuests] could not read store, starting empty:', err.message);
    known = new Set();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({ jids: [...known] }, null, 2));
  } catch (err) {
    console.error('[knownGuests] could not write store:', err.message);
  }
}

/** True the first time a JID is ever seen; false forever after. */
export function isFirstContact(jid) {
  load();
  return !known.has(jid);
}

/** Records a JID as seen. Safe to call repeatedly. */
export function markSeen(jid) {
  load();
  if (known.has(jid)) return;
  known.add(jid);
  persist();
}

/** Number of chats on record - used by the seeding script. */
export function knownCount() {
  load();
  return known.size;
}

/** Bulk-add, for seeding existing conversations at rollout. */
export function seed(jids) {
  load();
  let added = 0;
  for (const j of jids) {
    if (!known.has(j)) { known.add(j); added++; }
  }
  if (added) persist();
  return added;
}

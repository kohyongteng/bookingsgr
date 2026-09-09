// One-off rollout helper for the "welcome only on first contact" feature.
//
// The known-guests store starts empty, which would make every guest already
// mid-conversation look like a brand-new contact and get re-welcomed on their
// next greeting. This seeds it from JIDs the bot has already handled, which
// its pm2 logs record.
//
// Safe to re-run: seeding is additive and de-duplicated.
//
//   node seed-known-guests.js            # dry run
//   node seed-known-guests.js --apply

import fs from 'fs';
import { seed, knownCount } from './src/knownGuests.js';

const APPLY = process.argv.includes('--apply');

const LOGS = [
  'C:\\Users\\scada\\.pm2\\logs\\whatsapp-bot-v2-out.log',
  'C:\\Users\\scada\\.pm2\\logs\\whatsapp-bot-v2-error.log',
  'C:\\Users\\scada\\.pm2\\logs\\whatsapp-bot-out.log',
  'C:\\Users\\scada\\.pm2\\logs\\whatsapp-bot-error.log',
];

// Individual chats only. Groups (@g.us) are never guests, and the bot's own
// JIDs carry a ":device" suffix so they can't match this pattern.
const JID_RE = /\b\d{8,}@(?:s\.whatsapp\.net|lid)\b/g;

const found = new Set();
for (const file of LOGS) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(JID_RE)) found.add(m[0]);
}

console.log(`known before : ${knownCount()}`);
console.log(`found in logs: ${found.size}`);

if (APPLY) {
  const added = seed([...found]);
  console.log(`added        : ${added}`);
  console.log(`known after  : ${knownCount()}`);
} else {
  console.log('(dry run - nothing written. Re-run with --apply.)');
}

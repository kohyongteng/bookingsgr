/**
 * test-outbox-send.js
 * Sends ONE test message through the same outbox mechanism the real
 * scanner uses, to a WhatsApp group - lets you confirm the pipeline
 * (this script -> wa-outbox folder -> whatsapp-bot's outboxWatcher ->
 * actual WhatsApp send) works before relying on the real 9AM scan.
 *
 * Defaults to the TEST group ("Boston Check In Out") so you don't spam
 * real housekeeping while testing. Pass --live to send to the real
 * housekeeping group ("Boston SGR Swiss Garden") instead.
 *
 * Usage:
 *   node test-outbox-send.js                # sends to test group
 *   node test-outbox-send.js --live         # sends to real housekeeping group
 *   node test-outbox-send.js "N1901 no AC"  # custom message, test group
 */
const fs = require('fs');
const path = require('path');

const OUTBOX_DIR = 'C:\\apps\\shared-data\\wa-outbox';
const HOUSEKEEPING_GROUP_JID = '120363424480363759@g.us'; // "Boston SGR Swiss Garden"
const TEST_GROUP_JID = '120363402060306853@g.us'; // "Boston Check In Out"
const BOT_SUFFIX = ' (bot)';

const args = process.argv.slice(2);
const live = args.includes('--live');
const customMessage = args.find((a) => a !== '--live');

const groupJid = live ? HOUSEKEEPING_GROUP_JID : TEST_GROUP_JID;
const message = (customMessage || 'N1901, S2004 no AC') +
  (live ? '' : ' [TEST from test-outbox-send.js]') + BOT_SUFFIX;

if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
const filename = `manual-test-${Date.now()}.json`;
fs.writeFileSync(path.join(OUTBOX_DIR, filename), JSON.stringify({ groupJid, message }), 'utf8');

console.log(`Wrote ${filename} to ${OUTBOX_DIR}`);
console.log(`  -> group: ${groupJid} ${live ? '(REAL housekeeping group)' : '(test group)'}`);
console.log(`  -> message: "${message}"`);
console.log(`whatsapp-bot polls this folder every 10s by default - check the group shortly.`);

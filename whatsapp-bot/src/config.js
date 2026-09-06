import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env and fill it in)`);
  }
  return v;
}

export const config = {
  claude: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
  },
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  },
  staffGroupJid: process.env.STAFF_GROUP_JID || '120363405393193359@g.us',
  housekeepingGroupJid: process.env.HOUSEKEEPING_GROUP_JID || '120363424480363759@g.us',
  debounceMs: Number(process.env.DEBOUNCE_MS || 30_000),
  replyDelayMs: Number(process.env.REPLY_DELAY_MS || 15_000),
  authDir: process.env.AUTH_DIR || './auth_info_baileys',
  logLevel: process.env.LOG_LEVEL || 'info',
  botSuffix: ' (bot)',
  // Shared folder polled for messages dropped by bookings-dashboard/email-processor
  // (a separate process with no access to this bot's live WhatsApp connection).
  // The bot doesn't know or care what a "checkout report" is - it just sends
  // whatever {groupJid, message} JSON files show up here.
  outboxDir: process.env.OUTBOX_DIR || 'C:\\apps\\shared-data\\wa-outbox',
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 10_000),
};

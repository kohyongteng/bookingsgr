import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { createHandler } from './handler.js';
import { startOutboxWatcher } from './outboxWatcher.js';

process.on('uncaughtException', (err) => {
  console.error(`[FATAL][whatsapp-bot] Uncaught exception:`, err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL][whatsapp-bot] Unhandled rejection:`, reason);
  process.exit(1);
});

const logger = pino({ level: config.logLevel });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Swiss Garden Bot'),
    // printQRInTerminal is deprecated in recent Baileys — we render the QR ourselves below.
  });

  const handler = createHandler(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with the Swiss Garden WhatsApp Business number:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed.', { statusCode, shouldReconnect });
      if (shouldReconnect) {
        start().catch((err) => console.error('Reconnect failed:', err));
      } else {
        console.error('Logged out — delete the auth folder and re-scan the QR to relink.');
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp.');
      startOutboxWatcher(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // only handle new live messages, not history sync
    for (const msg of messages) {
      try {
        await handler.onMessage(msg);
      } catch (err) {
        console.error('[index] error handling message:', err);
      }
    }
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

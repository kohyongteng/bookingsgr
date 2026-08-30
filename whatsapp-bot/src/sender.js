import { config } from './config.js';

/**
 * Wraps a Baileys socket with the few send operations this bot needs.
 * This is the ONLY place that actually calls sock.sendMessage — the AI never
 * gets a "send" tool; it only returns classification text that this
 * deterministic code acts on.
 */
export function createSender(sock) {
  return {
    /** Send a guest-facing reply. Appends " (bot)" unless already present. */
    async sendGuestText(jid, text) {
      const withSuffix = text.endsWith(config.botSuffix) ? text : text + config.botSuffix;
      return sock.sendMessage(jid, { text: withSuffix });
    },

    /** Internal message to staff/housekeeping group — no bot suffix (not guest-facing). */
    async sendStaffText(jid, text) {
      return sock.sendMessage(jid, { text });
    },

    /** Forward a raw media buffer to staff group with a caption. type: 'image' | 'video' | 'audio' | 'document' */
    async forwardMedia(jid, { type, buffer, mimetype, caption, fileName }) {
      const payload = { caption };
      if (type === 'image') payload.image = buffer;
      else if (type === 'video') payload.video = buffer;
      else if (type === 'audio') { payload.audio = buffer; payload.mimetype = mimetype; }
      else { payload.document = buffer; payload.mimetype = mimetype; payload.fileName = fileName || 'file'; }
      return sock.sendMessage(jid, payload);
    },
  };
}

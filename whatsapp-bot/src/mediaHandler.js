import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { classifyImage, transcribeAudio } from './gemini.js';
import { formatSenderLabel } from './util.js';

/** Pull the first media attachment (if any) out of a Baileys message, downloaded as a Buffer. */
export async function extractMedia(msg) {
  const m = msg.message;
  if (!m) return null;

  if (m.imageMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return { type: 'image', buffer, mimeType: m.imageMessage.mimetype || 'image/jpeg', caption: m.imageMessage.caption || '' };
  }
  if (m.videoMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return { type: 'video', buffer, mimeType: m.videoMessage.mimetype || 'video/mp4', caption: m.videoMessage.caption || '' };
  }
  if (m.audioMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return { type: 'audio', buffer, mimeType: m.audioMessage.mimetype || 'audio/ogg; codecs=opus' };
  }
  if (m.documentMessage) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return {
      type: 'document',
      buffer,
      mimeType: m.documentMessage.mimetype || 'application/octet-stream',
      fileName: m.documentMessage.fileName || 'document',
      caption: m.documentMessage.caption || '',
    };
  }
  return null;
}

/**
 * Handle a non-text attachment per the SKILL.md media rules. Returns a hint object
 * telling handler.js what happened, so it can decide the guest-facing reply.
 *
 * @returns {Promise
 *   | { kind: 'id_document' }                          // guest_id_received template only — NOT forwarded to staff
 *   | { kind: 'photo_forwarded' }                       // send handoff ack
 *   | { kind: 'video_forwarded' }                       // send handoff ack
 *   | { kind: 'voice_transcribed', transcript: string }  // feed transcript into normal text matching
 * >}
 */
export async function handleMedia({ media, sender, sendStaffText, forwardMedia }) {
  const label = formatSenderLabel(sender.name, sender.e164);

  if (media.type === 'image') {
    const base64 = media.buffer.toString('base64');
    const { isIdDocument, oneLineDescription } = await classifyImage({
      base64,
      mimeType: media.mimeType,
      captionText: media.caption,
    });

    if (isIdDocument) {
      // ID photos are NOT forwarded to staff (by design) — the guest just gets
      // the "guest_id_received" template reply. See templates.js.
      return { kind: 'id_document' };
    }

    await forwardMedia(config.staffGroupJid, {
      type: 'image',
      buffer: media.buffer,
      caption: `📷 GUEST PHOTO from ${label}: ${oneLineDescription}`,
    });
    return { kind: 'photo_forwarded' };
  }

  if (media.type === 'video') {
    await forwardMedia(config.staffGroupJid, {
      type: 'video',
      buffer: media.buffer,
      caption: `🎥 GUEST VIDEO from ${label}`,
    });
    return { kind: 'video_forwarded' };
  }

  if (media.type === 'audio') {
    const base64 = media.buffer.toString('base64');
    const transcript = await transcribeAudio({ base64, mimeType: media.mimeType });
    return { kind: 'voice_transcribed', transcript };
  }

  // Documents that aren't images/video/audio (rare from guests) — forward and hand off.
  await forwardMedia(config.staffGroupJid, {
    type: 'document',
    buffer: media.buffer,
    mimetype: media.mimeType,
    fileName: media.fileName,
    caption: `📎 GUEST FILE from ${label}`,
  });
  return { kind: 'photo_forwarded' };
}

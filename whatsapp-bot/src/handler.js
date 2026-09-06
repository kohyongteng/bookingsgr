import { config } from './config.js';
import { createSender } from './sender.js';
import { Debouncer, DelayedReplyScheduler } from './queue.js';
import { extractMedia, handleMedia } from './mediaHandler.js';
import { matchIntents } from './claude.js';
import { TEMPLATE_BY_ID, UNMATCHED, HANDOFF_ACK_TEXT, LUGGAGE_STORAGE_CONFIRMED_TEXT } from './templates.js';
import { isGroupJid, jidToE164, formatSenderLabel } from './util.js';

export function createHandler(sock) {
  const sender = createSender(sock);
  const scheduler = new DelayedReplyScheduler(config.replyDelayMs);

  // Message IDs the bot itself sent, so we can tell a staff member's manual
  // reply (also fromMe, since it comes from the same linked WhatsApp account)
  // apart from the bot's own sends. Self-cleaning after 10 minutes.
  const ownSentIds = new Set();
  function markOwn(id) {
    if (!id) return;
    ownSentIds.add(id);
    setTimeout(() => ownSentIds.delete(id), 10 * 60 * 1000);
  }

  // WhatsApp may address the same chat by a LID (`@lid`) or by the real phone
  // JID (`@s.whatsapp.net`). A guest's message and a staff member's manual
  // reply in that same chat can arrive under DIFFERENT forms - which is why
  // cancelling by the raw remoteJid alone silently missed takeovers. Baileys
  // gives us the other form in key.remoteJidAlt, so we remember both
  // directions and treat them as the same conversation everywhere.
  const jidAliases = new Map(); // jid -> the other known form of the same chat

  function rememberAlias(jid, altJid) {
    if (!altJid || altJid === jid) return;
    jidAliases.set(jid, altJid);
    jidAliases.set(altJid, jid);
  }

  /** Every JID form we know for this chat (always includes the one passed in). */
  function aliasKeysFor(jid) {
    const alt = jidAliases.get(jid);
    return alt ? [jid, alt] : [jid];
  }

  // When a human last replied in each chat, keyed by every known JID alias.
  const lastHumanReplyAt = new Map();

  function markHumanReply(jid) {
    const now = Date.now();
    for (const k of aliasKeysFor(jid)) lastHumanReplyAt.set(k, now);
  }

  /** Did a human reply in this chat at or after the given moment? */
  function humanRepliedSince(jid, sinceMs) {
    for (const k of aliasKeysFor(jid)) {
      const t = lastHumanReplyAt.get(k);
      if (t && t >= sinceMs) return true;
    }
    return false;
  }

  // Guests who were just asked to confirm luggage storage (luggage_storage
  // topic matched) but haven't replied yet - keyed by every known JID alias,
  // value is the setTimeout handle so it can be cleared once confirmed.
  // Auto-expires after 24h so a guest who never replies doesn't stay "pending" forever.
  const pendingLuggageConfirmation = new Map();

  function markLuggagePending(jid) {
    clearLuggagePending(jid); // replace any earlier pending timer for this chat
    const timeout = setTimeout(() => clearLuggagePending(jid), 24 * 60 * 60 * 1000);
    for (const k of aliasKeysFor(jid)) pendingLuggageConfirmation.set(k, timeout);
  }

  function clearLuggagePending(jid) {
    for (const k of aliasKeysFor(jid)) {
      const timeout = pendingLuggageConfirmation.get(k);
      if (timeout) clearTimeout(timeout);
      pendingLuggageConfirmation.delete(k);
    }
  }

  function isLuggagePending(jid) {
    return aliasKeysFor(jid).some((k) => pendingLuggageConfirmation.has(k));
  }

  // Deliberately deterministic (not AI) - this gates sending storeroom access
  // details (passcode, QR reminder). The confirm-ask template now explicitly
  // tells the guest to reply "Yes", so this only matches that instructed word
  // (plus close variants) rather than guessing across a loose set of phrases.
  // Checked per-line so a guest who sends "yes" and "please confirm" as two
  // quick separate messages (combined by the debouncer) still matches.
  const LUGGAGE_CONFIRM_REGEX = /^(yes|yeah|yep|yup|y)[\s!.,]*(please)?[\s!.,]*$/i;
  function isLuggageConfirmation(text) {
    return text.split('\n').some((line) => LUGGAGE_CONFIRM_REGEX.test(line.trim()));
  }

  async function sendGuestTextTracked(jid, text) {
    const result = await sender.sendGuestText(jid, text);
    markOwn(result?.key?.id);
    return result;
  }

  /**
   * Queue a guest-facing reply, but only actually send it if no human has
   * replied since the guest's last message. This covers BOTH windows - the
   * debounce wait and the reply delay - so a staff member who jumps in at any
   * point after the guest wrote stops the bot from piling on afterwards.
   */
  function scheduleGuestReply(jid, sinceMs, text) {
    scheduler.schedule(
      aliasKeysFor(jid),
      () => sendGuestTextTracked(jid, text),
      () => !humanRepliedSince(jid, sinceMs)
    );
  }

  const debouncer = new Debouncer(config.debounceMs, (jid, batch) => {
    processBatch(jid, batch).catch((err) => console.error(`[handler] processBatch failed for ${jid}:`, err));
  });

  async function processBatch(jid, batch) {
    const senderMeta = batch[batch.length - 1].sender; // most recent message's pushName/e164

    // Anchor point for the human-takeover check: anything a human sends after
    // the guest's last message means the conversation has been taken over.
    const guestLastMessageAt = batch[batch.length - 1].receivedAt ?? Date.now();

    let combinedText = batch.map((m) => m.text).filter(Boolean).join('\n');
    let idDetected = false;
    let mediaHandoffTriggered = false;

    for (const item of batch) {
      if (!item.media) continue;
      const result = await handleMedia({
        media: item.media,
        sender: senderMeta,
        sendStaffText: sender.sendStaffText,
        forwardMedia: sender.forwardMedia,
      });
      if (result.kind === 'id_document') idDetected = true;
      if (result.kind === 'photo_forwarded' || result.kind === 'video_forwarded') mediaHandoffTriggered = true;
      if (result.kind === 'voice_transcribed' && result.transcript) {
        combinedText = [combinedText, result.transcript].filter(Boolean).join('\n');
      }
    }

    if (idDetected) {
      const template = TEMPLATE_BY_ID.guest_id_received;
      scheduleGuestReply(jid, guestLastMessageAt, template.reply);
      return;
    }

    if (mediaHandoffTriggered) {
      scheduleGuestReply(jid, guestLastMessageAt, HANDOFF_ACK_TEXT);
      return;
    }

    if (!combinedText.trim()) return; // nothing to match on (shouldn't normally happen)

    // Luggage storage confirmation - checked before intent classification so a
    // plain "yes" replying to our confirm-ask isn't sent through the classifier.
    if (isLuggagePending(jid) && isLuggageConfirmation(combinedText)) {
      clearLuggagePending(jid);
      scheduleGuestReply(jid, guestLastMessageAt, LUGGAGE_STORAGE_CONFIRMED_TEXT);
      await sender.sendStaffText(
        config.staffGroupJid,
        `📦 Luggage storage CONFIRMED by ${formatSenderLabel(senderMeta.name, senderMeta.e164)} — please send them the QR code for the South Tower Level 12 storeroom.`
      );
      return;
    }

    const templateIds = await matchIntents({ text: combinedText });
    const hasUnmatched = templateIds.includes(UNMATCHED);
    const matchedIds = templateIds.filter((id) => id !== UNMATCHED);

    if (hasUnmatched) {
      // Handoff rule: forward to staff immediately (whether or not other topics also matched).
      await sender.sendStaffText(
        config.staffGroupJid,
        `🚨 GUEST QUERY from ${formatSenderLabel(senderMeta.name, senderMeta.e164)}: ${combinedText}`
      );
    }

    if (matchedIds.includes('luggage_storage')) markLuggagePending(jid);

    // Combine every matched template's reply, plus the handoff ack if part of the
    // guest's message wasn't covered by any template — sent as ONE guest-facing
    // message so a multi-question burst (e.g. "car park?" + "wifi password?")
    // gets every answer instead of only the first match.
    const replyParts = matchedIds.map((id) => TEMPLATE_BY_ID[id].reply);
    if (hasUnmatched) replyParts.push(HANDOFF_ACK_TEXT);

    if (replyParts.length === 0) return; // shouldn't happen — matchIntents always returns at least one id
    const combinedReply = replyParts.join('\n\n');
    scheduleGuestReply(jid, guestLastMessageAt, combinedReply);
  }

  /** Call for every incoming message from Baileys' messages.upsert event. */
  async function onMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    // Learn the LID <-> phone-number pairing for this chat from EVERY message
    // (incoming or outgoing), so a later cancel under either form matches.
    rememberAlias(jid, msg.key.remoteJidAlt);

    // Human takeover detection: a message sent from the linked account (fromMe)
    // straight into a guest's DM that we did NOT send ourselves means a staff
    // member is replying manually — cancel any reply we have queued for them,
    // and record the moment so the pre-send guard also suppresses a reply that
    // hasn't been scheduled yet (e.g. staff replied during the debounce wait).
    if (msg.key.fromMe) {
      if (!isGroupJid(jid) && !ownSentIds.has(msg.key.id)) {
        markHumanReply(jid);
        let cancelled = false;
        for (const k of aliasKeysFor(jid)) {
          if (scheduler.cancel(k)) cancelled = true;
        }
        console.log(
          `[handler] staff manual reply detected for ${jid}` +
            (cancelled ? ' — cancelled queued bot reply' : ' — nothing queued; bot will stay silent for this message')
        );
      }
      return; // never process our own/staff outgoing messages as guest input
    }

    // Groups: only the housekeeping/staff groups exist as groups in this workflow,
    // and neither should ever drive guest-reply logic.
    if (isGroupJid(jid)) return;
    if (jid === config.housekeepingGroupJid || jid === config.staffGroupJid) return;

    if (msg.message?.protocolMessage || msg.message?.reactionMessage) return; // ignore edits/deletes/reactions

    const sender = {
      name: msg.pushName || 'Guest',
      e164: jidToE164(jid, msg.key.remoteJidAlt),
    };

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';

    let media = null;
    try {
      media = await extractMedia(msg);
    } catch (err) {
      console.error(`[handler] media download failed for ${jid}:`, err);
    }

    debouncer.push(jid, { text, media, sender, receivedAt: Date.now() });
  }

  return { onMessage };
}


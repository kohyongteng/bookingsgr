import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { createSender } from './sender.js';
import { Debouncer, DelayedReplyScheduler } from './queue.js';
import { extractMedia, handleMedia } from './mediaHandler.js';
import { matchIntents } from './claude.js';
import { checkAnswerableGap, writeGapAlert } from './gapCheck.js';
import { TEMPLATE_BY_ID, UNMATCHED, HANDOFF_ACK_TEXT, LUGGAGE_STORAGE_CONFIRMED_TEXT } from './templates.js';
import { isGroupJid, jidToE164, formatSenderLabel } from './util.js';
import { isFirstContact, markSeen } from './knownGuests.js';

// Shared with email-processor's airbnbChatReply.js - a staff "Proceed" reply
// (quoting an Airbnb reply proposal) in the staff group writes a small file
// here for that project's cycle to pick up. This bot stays otherwise "dumb"
// about what the ref means, same as the wa-outbox design.
const AIRBNB_APPROVALS_DIR = 'C:\\apps\\shared-data\\airbnb-approvals';

/** Text of the quoted message a reply is responding to, or null if none. */
function extractQuotedText(msg) {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted) return null;
  return (
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    null
  );
}

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

    // Captured and recorded up front, before any of the early returns below:
    // a guest whose opening message is an ID photo or a plain question must
    // still count as "seen", otherwise a later "hi" would look like first
    // contact and trigger a welcome mid-conversation.
    //
    // Checked/recorded across EVERY known JID alias: the same chat reaches us
    // as both @lid and @s.whatsapp.net (see rememberAlias), so keying on the
    // raw jid alone would treat the second form as a new guest and welcome
    // the same person twice.
    const chatKeys = aliasKeysFor(jid);
    const firstContact = chatKeys.every((k) => isFirstContact(k));
    for (const k of chatKeys) markSeen(k);

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
    // Without this there was no way to answer "why did the bot send X?" from
    // the logs - the classification was never recorded anywhere.
    console.log(
      `[handler] classified ${jid} as ${JSON.stringify(templateIds)}` +
      `${firstContact ? ' (first contact)' : ''}: ${JSON.stringify(combinedText.slice(0, 120))}`
    );
    const hasUnmatched = templateIds.includes(UNMATCHED);
    const wantsExtendStay = templateIds.includes('extend_stay');
    // Two filters here:
    //  - .reply guards templates that deliberately carry no text; without it a
    //    null would reach the join() below and send the literal word "null".
    //  - new_guest is the welcome/check-in message, and is only ever sent on a
    //    guest's genuine first contact. Someone greeting us again mid-stay
    //    still classifies as new_guest, but must not be re-welcomed.
    const matchedIds = templateIds.filter(
      (id) =>
        id !== UNMATCHED &&
        id !== 'extend_stay' &&
        TEMPLATE_BY_ID[id]?.reply &&
        (id !== 'new_guest' || firstContact)
    );

    if (hasUnmatched) {
      // Handoff rule: forward to staff immediately (whether or not other topics also matched).
      await sender.sendStaffText(
        config.staffGroupJid,
        `🚨 GUEST QUERY from ${formatSenderLabel(senderMeta.name, senderMeta.e164)}: ${combinedText}`
      );

      // Background-only "you might be missing a template" signal - never
      // blocks the guest reply. See gapCheck.js for why this stays silent on
      // genuinely novel questions and only fires when the answer is already
      // sitting in an existing template's text.
      checkAnswerableGap({ text: combinedText })
        .then((gap) => {
          if (gap.answerable) {
            writeGapAlert({
              question: combinedText,
              answer: gap.answer,
              note: gap.note,
              guestLabel: formatSenderLabel(senderMeta.name, senderMeta.e164),
            });
          }
        })
        .catch((err) => console.error('[handler] gap check failed:', err));
    }

    if (wantsExtendStay) {
      // Availability needs a human to check the calendar - always forward, never auto-reply.
      await sender.sendStaffText(
        config.staffGroupJid,
        `🗓️ EXTEND STAY REQUEST from ${formatSenderLabel(senderMeta.name, senderMeta.e164)}: ${combinedText}`
      );
    }

    if (matchedIds.includes('luggage_storage')) markLuggagePending(jid);

    // Combine every matched template's reply, plus the handoff ack if part of the
    // guest's message wasn't covered by any template — sent as ONE guest-facing
    // message so a multi-question burst (e.g. "car park?" + "wifi password?")
    // gets every answer instead of only the first match.
    const replyParts = matchedIds.map((id) => TEMPLATE_BY_ID[id].reply);
    if (hasUnmatched || wantsExtendStay) replyParts.push(HANDOFF_ACK_TEXT);

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
    // and neither should ever drive guest-reply logic - EXCEPT one narrow
    // case: a staff "Proceed" reply (quoting an Airbnb reply proposal) in the
    // staff group, which approves a pending Airbnb chat-relay reply. See
    // email-processor's airbnbChatReply.js for the other half of this loop.
    if (isGroupJid(jid)) {
      if (jid === config.staffGroupJid) {
        const groupText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (/^proceed$/i.test(groupText.trim())) {
          const quotedText = extractQuotedText(msg);
          const refMatch = quotedText?.match(/\[ref:\s*([a-zA-Z0-9]+)\]/);
          if (refMatch) {
            const ref = refMatch[1];
            if (!fs.existsSync(AIRBNB_APPROVALS_DIR)) fs.mkdirSync(AIRBNB_APPROVALS_DIR, { recursive: true });
            fs.writeFileSync(
              path.join(AIRBNB_APPROVALS_DIR, `approval-${Date.now()}.json`),
              JSON.stringify({ ref, approvedAt: new Date().toISOString() }),
              'utf8'
            );
            console.log(`[handler] Airbnb reply approved by staff: ref ${ref}`);
          } else {
            console.log('[handler] staff sent "Proceed" in staff group but no [ref: ...] found in the quoted message - ignoring');
          }
        }
      }
      return;
    }

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


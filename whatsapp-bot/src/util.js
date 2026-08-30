export const isGroupJid = (jid) => jid.endsWith('@g.us');

/**
 * WhatsApp has been rolling out "LID" (Local/Linked ID) JIDs -- an internal
 * identifier that looks like a phone number but isn't one -- instead of the
 * guest's real number in some cases. Naively reformatting every JID as if it
 * were a phone number produces a fake-looking number for LID-addressed chats.
 *
 * Baileys (v7+) pairs a LID-addressed message with `key.remoteJidAlt`, which
 * holds the real phone-number JID for that same chat. We use that when the
 * primary JID is a LID, and only fall back to "unavailable" if neither is a
 * real phone-number JID (e.g. Alt not yet known for a brand-new chat).
 *
 * Note: replying still works correctly either way -- Baileys sends to
 * whatever JID the message came from, phone-number or LID. This only affects
 * the human-readable label shown to staff.
 *
 * @param {string} jid the message's primary key.remoteJid
 * @param {string} [altJid] the message's key.remoteJidAlt, if present
 */
export function jidToE164(jid, altJid) {
  const asPhoneNumber = (j) => (j && j.endsWith('@s.whatsapp.net') ? '+' + j.split('@')[0].split(':')[0] : null);
  return asPhoneNumber(jid) ?? asPhoneNumber(altJid);
}

/** Human-readable "Name (number)" label for staff-facing messages, honest about LID cases. */
export function formatSenderLabel(name, e164) {
  const displayName = name || 'Guest';
  return e164 ? `${displayName} (${e164})` : `${displayName} (number unavailable -- WhatsApp privacy ID)`;
}

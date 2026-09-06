// Airbnb chat-relay auto-reply system. See spicy-wobbling-dragonfly.md (the
// plan) for the full design and the research it's based on.
//
// Every inbound message in a "RE: Reservation for #NN..." thread has
// identical From: Airbnb <express@airbnb.com> - direction (guest vs staff)
// is determined by parsing role-labeled bubbles in the body ("Booker" =
// guest, "Host"/"Co-host" = staff replying via Airbnb's own app), not
// headers. A reply must be threaded correctly (threadId + the target
// message's own Reply-To + Message-Id) to relay into the guest's Airbnb
// chat - see lib.sendThreadedReply.
//
// Nothing guest-facing sends automatically: a matched template's reply is
// proposed to the staff WhatsApp group and only actually sent once a staff
// member replies "Proceed" (quoting the proposal) - see whatsapp-bot's
// handler.js for the other half of that loop.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const airbnbClaude = require('./airbnbClaude');
const { TEMPLATE_BY_ID, UNMATCHED, TECHNICAL_ISSUE_TOPICS } = require('./airbnbTemplates');

const STATE_PATH = path.join(__dirname, 'airbnb-chat-reply-state.json');
const PENDING_APPROVALS_PATH = path.join(__dirname, 'airbnb-pending-approvals.json');
const APPROVALS_DIR = 'C:\\apps\\shared-data\\airbnb-approvals';

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- Digest body parsing ----------

const ROLE_PATTERN = 'Booker|Host|Co-host';

// Airbnb's digest body lists every chat bubble so far, each as a
// Name / Role / Message block. Splits on the known, fixed role tokens
// (guest names vary, so those can't be used as anchors) and returns them in
// chronological order - the LAST entry is the newest activity.
function parseDigestBubbles(bodyText) {
  // Real digest format uses CRLF with a blank (whitespace-only) line between
  // Name / Role / Text, e.g. "   NURFARZANA\r\n   \r\n   Booker\r\n   \r\n   Hi".
  // After the LAST bubble's text, Airbnb appends its own "Reply\n[link]" UI
  // chrome before the rest of the footer - that must terminate the capture
  // too, or the last bubble's text swallows the entire email footer.
  const regex = new RegExp(
    `\\r?\\n\\s*([^\\r\\n]+?)\\r?\\n\\s*(${ROLE_PATTERN})\\r?\\n([\\s\\S]*?)` +
      `(?=\\r?\\n\\s*[^\\r\\n]+\\r?\\n\\s*(?:${ROLE_PATTERN})\\r?\\n|\\r?\\n\\r?\\nReply\\r?\\n|$)`,
    'g'
  );
  const bubbles = [];
  let m;
  while ((m = regex.exec(bodyText)) !== null) {
    bubbles.push({ name: m[1].trim(), role: m[2].trim(), text: m[3].trim() });
  }
  return bubbles;
}

// Best-effort: parses a date range like "May 7 – 12" or "Aug 30 – Sep 2" out
// of the thread subject into ISO check_in/check_out dates for the
// findAssignedRoomByGuestAndDates lookup. No year in the subject, so assumes
// the current year, rolling to next year if that would land far in the past
// (a booking's dates are never more than ~60 days behind "now" in practice).
// Returns { checkIn: null, checkOut: null } if the subject doesn't parse -
// callers must handle nulls gracefully (this is a "nice to have" for the
// room lookup, not load-bearing for the rest of the pipeline).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseSubjectDates(subject, now = new Date()) {
  const match = subject.match(/([A-Za-z]{3,9})\s+(\d{1,2})\s*[–—-]\s*(?:([A-Za-z]{3,9})\s+)?(\d{1,2})/);
  if (!match) return { checkIn: null, checkOut: null };

  const [, mon1Str, day1Str, mon2Str, day2Str] = match;
  const mon1 = MONTHS.findIndex((m) => mon1Str.slice(0, 3).toLowerCase() === m.toLowerCase());
  const mon2 = mon2Str
    ? MONTHS.findIndex((m) => mon2Str.slice(0, 3).toLowerCase() === m.toLowerCase())
    : mon1;
  if (mon1 === -1 || mon2 === -1) return { checkIn: null, checkOut: null };

  function toIso(year, monthIndex, day) {
    return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  let year = now.getFullYear();
  let checkIn = new Date(year, mon1, parseInt(day1Str, 10));
  // If this date is more than ~60 days in the past, the booking is almost
  // certainly for next year (subject has no year, so this is inferred).
  if ((now - checkIn) / (1000 * 60 * 60 * 24) > 60) {
    year += 1;
    checkIn = new Date(year, mon1, parseInt(day1Str, 10));
  }

  return {
    checkIn: toIso(year, mon1, parseInt(day1Str, 10)),
    checkOut: toIso(year, mon2, parseInt(day2Str, 10)),
  };
}

// ---------- Gmail thread helpers ----------

function getHeader(message, name) {
  const h = (message.payload.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** Most recent INBOX message in the thread (the latest digest snapshot). */
function latestInboxMessage(thread) {
  const inbox = thread.messages.filter((m) => (m.labelIds || []).includes('INBOX'));
  if (inbox.length === 0) return null;
  return inbox.reduce((a, b) => (parseInt(a.internalDate, 10) > parseInt(b.internalDate, 10) ? a : b));
}

/** Is there a SENT message in the thread newer than the given message? */
function hasSentMessageAfter(thread, afterInternalDate) {
  return thread.messages.some(
    (m) => (m.labelIds || []).includes('SENT') && parseInt(m.internalDate, 10) > afterInternalDate
  );
}

// ---------- Main cycle ----------

async function runAirbnbChatReplyCycle() {
  const now = new Date();
  const state = loadJson(STATE_PATH, {});
  const pendingApprovals = loadJson(PENDING_APPROVALS_PATH, {});
  const gmail = lib.getGmailClient('airbnb');
  const db = lib.openDb();

  // Every thread this cycle looks at gets recorded here, whether or not
  // anything was sent - this is the answer to "which emails have already
  // been scanned and what happened to them". A threadId missing from this
  // file has simply never been seen yet by this cycle.
  function recordState(threadId, { internalDate, messageId, subject, guestName, guestText, outcome }) {
    state[threadId] = {
      internalDate,
      messageId,
      subject: subject || (state[threadId] && state[threadId].subject) || null,
      guestName: guestName ?? null,
      guestText: guestText ?? null,
      outcome,
      scannedAt: now.toISOString(),
    };
  }

  try {
    // newer_than:3d, not 30d - state tracking means nothing is ever
    // reprocessed regardless of window size, but scanning every thread
    // touched in the last month on every cycle was a major contributor to
    // exhausting this project's shared Gmail per-minute quota (see the
    // comment above the metadata-first fetch below for the other half of
    // that fix). 3 days comfortably covers a guest's actual stay window.
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: 'subject:"Reservation for #" newer_than:3d',
      maxResults: 50,
    });
    const threadRefs = listRes.data.threads || [];

    for (const ref of threadRefs) {
      // Cheap first pass: metadata only (no message bodies), just enough to
      // tell whether this thread has anything new since last cycle. Most
      // threads are unchanged most cycles, so skipping the expensive
      // full-body fetch here is what keeps this cycle within Gmail's
      // per-minute quota - fetching format:'full' for every thread every 5
      // minutes regardless of change is what was exhausting it before.
      const { data: metaThread } = await gmail.users.threads.get({
        userId: 'me',
        id: ref.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'Reply-To', 'Message-Id'],
      });
      const metaLatest = latestInboxMessage(metaThread);
      if (!metaLatest) continue;

      const latestInternalDate = parseInt(metaLatest.internalDate, 10);
      const subject = getHeader(metaLatest, 'Subject') || '';
      const lastProcessed = state[ref.id];
      if (lastProcessed && lastProcessed.internalDate >= latestInternalDate) continue; // nothing new since last scan

      // Staff already replied via Gmail webmail since the last thing we saw?
      // (labelIds/internalDate are present on metadata fetches too - no need
      // for the full body to answer this.)
      if (hasSentMessageAfter(metaThread, lastProcessed ? lastProcessed.internalDate : 0)) {
        recordState(ref.id, { internalDate: latestInternalDate, messageId: metaLatest.id, subject, outcome: 'skipped-staff-replied-via-gmail' });
        continue;
      }

      // Something's actually new - now pay for the full body fetch.
      const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: ref.id, format: 'full' });
      const latest = latestInboxMessage(thread);
      if (!latest) continue;

      const { text: bodyText } = lib.extractBody(latest.payload);
      const bubbles = parseDigestBubbles(bodyText);
      const lastBubble = bubbles[bubbles.length - 1];

      // Already answered via Airbnb's own app, or nothing parseable - skip.
      if (!lastBubble || lastBubble.role !== 'Booker') {
        recordState(thread.id, {
          internalDate: latestInternalDate,
          messageId: latest.id,
          subject,
          outcome: lastBubble ? 'skipped-already-answered-via-airbnb-app' : 'skipped-unparseable',
        });
        continue;
      }

      const guestName = lastBubble.name;
      const guestText = lastBubble.text;

      console.log(`[${now.toISOString()}] Airbnb chat: new guest message in "${subject}" from ${guestName}: ${guestText}`);

      const templateIds = await airbnbClaude.matchIntents({ text: guestText });
      const hasUnmatched = templateIds.includes(UNMATCHED);
      const matchedIds = templateIds.filter((id) => id !== UNMATCHED && TEMPLATE_BY_ID[id]?.reply);
      const technicalIds = templateIds.filter((id) => TECHNICAL_ISSUE_TOPICS.has(id));

      if (hasUnmatched) {
        lib.writeOutboxMessage(
          lib.STAFF_GROUP_JID,
          `🚨 AIRBNB GUEST QUERY from ${guestName} (${subject}): ${guestText}`
        );
      }

      if (technicalIds.length > 0) {
        const { checkIn, checkOut } = parseSubjectDates(subject, now);
        let roomNote = 'room not yet determined';
        if (checkIn && checkOut) {
          const room = lib.findAssignedRoomByGuestAndDates(db, { guestName, checkIn, checkOut });
          roomNote = room ? `Room: ${room}` : 'Room: not yet assigned (guest may not be checked in yet)';
        }
        lib.writeOutboxMessage(
          lib.STAFF_GROUP_JID,
          `🔧 AIRBNB TECHNICAL ISSUE from ${guestName} (${subject}). ${roomNote}\nMessage: ${guestText}`
        );
      }

      if (matchedIds.length > 0) {
        const replyBody = matchedIds.map((id) => TEMPLATE_BY_ID[id].reply).join('\n\n');
        const to = getHeader(latest, 'Reply-To');
        const inReplyTo = getHeader(latest, 'Message-Id') || getHeader(latest, 'Message-ID');

        if (to && inReplyTo) {
          pendingApprovals[thread.id] = {
            to,
            inReplyTo,
            subject,
            replyBody,
            guestName,
            guestText,
            lastKnownInternalDate: latestInternalDate,
            createdAt: now.toISOString(),
          };
          saveJson(PENDING_APPROVALS_PATH, pendingApprovals);

          lib.writeOutboxMessage(
            lib.STAFF_GROUP_JID,
            `📋 Airbnb reply ready for approval\n[ref: ${thread.id}]\n\n` +
              `Guest: ${guestName}\nThread: ${subject}\nAsked: "${guestText}"\n\n` +
              `Proposed reply:\n"${replyBody}"\n\n` +
              `Reply "Proceed" (quoting this message) to send this to the guest.`
          );
        } else {
          console.error(`[${now.toISOString()}] Airbnb chat: missing Reply-To/Message-Id on thread ${thread.id}, cannot propose a reply`);
        }
      }

      const outcomeParts = [];
      if (matchedIds.length > 0) outcomeParts.push(`proposed:${matchedIds.join(',')}`);
      if (technicalIds.length > 0) outcomeParts.push(`technical-alert:${technicalIds.join(',')}`);
      if (hasUnmatched) outcomeParts.push('unmatched-alert');
      recordState(thread.id, {
        internalDate: latestInternalDate,
        messageId: latest.id,
        subject,
        guestName,
        guestText,
        outcome: outcomeParts.length > 0 ? outcomeParts.join('+') : 'no-action',
      });
    }

    saveJson(STATE_PATH, state);
  } catch (err) {
    console.error(`[${now.toISOString()}] Airbnb chat reply cycle error:`, err.message);
  } finally {
    db.close();
  }
}

// ---------- Approval pickup ----------

async function checkAndSendApprovedAirbnbReplies() {
  const now = new Date();
  if (!fs.existsSync(APPROVALS_DIR)) return;

  const files = fs.readdirSync(APPROVALS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return;

  const pendingApprovals = loadJson(PENDING_APPROVALS_PATH, {});
  const gmail = lib.getGmailClient('airbnb');

  for (const file of files) {
    const fullPath = path.join(APPROVALS_DIR, file);
    try {
      const { ref } = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const pending = pendingApprovals[ref];

      if (!pending) {
        console.log(`[${now.toISOString()}] Airbnb approval for unknown/expired ref ${ref} - ignoring.`);
        fs.unlinkSync(fullPath);
        continue;
      }

      // Re-verify nothing changed between proposal and approval.
      const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: ref, format: 'full' });
      if (hasSentMessageAfter(thread, pending.lastKnownInternalDate)) {
        console.log(`[${now.toISOString()}] Airbnb approval for ${ref} is stale (staff already replied via Gmail) - skipping send.`);
        delete pendingApprovals[ref];
        saveJson(PENDING_APPROVALS_PATH, pendingApprovals);
        fs.unlinkSync(fullPath);
        continue;
      }

      await lib.sendThreadedReply(gmail, {
        threadId: ref,
        to: pending.to,
        inReplyTo: pending.inReplyTo,
        subject: pending.subject,
        body: pending.replyBody,
      });
      console.log(`[${now.toISOString()}] Airbnb reply sent for thread ${ref} (approved by staff).`);

      delete pendingApprovals[ref];
      saveJson(PENDING_APPROVALS_PATH, pendingApprovals);
      fs.unlinkSync(fullPath);
    } catch (err) {
      console.error(`[${now.toISOString()}] Failed to process Airbnb approval ${file}:`, err.message);
      // leave the file in place - retried next cycle
    }
  }
}

module.exports = {
  runAirbnbChatReplyCycle,
  checkAndSendApprovedAirbnbReplies,
  // exported for testing
  parseDigestBubbles,
  parseSubjectDates,
};

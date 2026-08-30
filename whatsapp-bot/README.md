# Swiss Garden Residences — WhatsApp Guest Service Bot

Custom replacement for the OpenClaw-based bot. Built directly on
[Baileys](https://github.com/WhiskeySockets/Baileys) with **plain, deterministic JS**
for all control flow. Gemini is only ever asked to return classification text
(a template id, an image classification, or a transcription) — it never gets a
"send" tool and never controls how many times a message goes out.

## Architecture

```
index.js        Baileys connection lifecycle, QR pairing, reconnect handling
handler.js       Message router: group exclusion, debounce wiring, human-takeover
                 detection, orchestrates the whole per-guest flow
queue.js         Debouncer (batches a guest's rapid messages) +
                 DelayedReplyScheduler (delay-before-send, cancellable)
mediaHandler.js  Downloads attachments, classifies ID docs, forwards to staff
gemini.js        The ONLY place that calls the Gemini API — matching + transcription
templates.js     The 21 guest-reply templates (source of truth, ported from SKILL.md)
sender.js        The ONLY place that calls sock.sendMessage — appends " (bot)"
config.js        Env var loading
```

## Setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum set GEMINI_API_KEY
npm start
```

On first run, scan the printed QR code with the Swiss Garden **Business** WhatsApp
number (the linked-device flow, same as OpenClaw used). Session credentials are
saved to `AUTH_DIR` (default `./auth_info_baileys`) so subsequent restarts
reconnect without re-scanning — unless you're moving from OpenClaw's own session,
in which case start fresh: link is per-app/session, not portable between two
different Baileys processes' auth folders. Re-linking on the same number does not
require unlinking anywhere else first.

## Deploying to the mini PC

Same workflow as before:

```bash
ssh scada-remote
cd path/to/whatsapp-bot   # after copying the project over, e.g. via git or scp
npm install
npm start   # or run under pm2 / a Windows service for persistence across reboots
```

Consider running under a process manager (e.g. `pm2`) so it auto-restarts on
crashes and survives the mini PC rebooting — not set up in this initial version.

## Design decisions worth knowing about

- **No blocking waits in the message handler.** Both the debounce and the
  reply-delay use per-guest `setTimeout`s stored in `Map`s (see `queue.js`), never
  a shared `await sleep()`. This was the root cause of one guest's delay stalling
  *all* guests on OpenClaw — structurally can't happen here since each guest's
  timers are independent.
- **Human takeover.** Every outgoing message the bot itself sends has its message
  ID recorded (`ownSentIds` in `handler.js`). When Baileys reports a `fromMe`
  message into a guest's DM whose ID isn't in that set, it must have been typed
  manually from the linked phone — the bot cancels any reply it had queued for
  that guest. This relies on Baileys' `fromMe` flag as discussed in the handoff notes.
- **Housekeeping group (`120363424480363759@g.us`) and the staff group itself are
  explicitly excluded** from guest-reply logic — only 1:1 guest chats
  (`@s.whatsapp.net` JIDs) are processed.
- **ID photos vs. other photos.** Rather than a separate rule engine, a single
  Gemini vision call (`classifyImage`) decides `isIdDocument` and produces the
  one-line caption for non-ID photos. If it's an ID doc → the `guest_id_received`
  template is sent to the guest and the file is forwarded to staff. Otherwise →
  photo is forwarded with a caption and the guest gets the standard handoff
  acknowledgment (matches SKILL.md's media-handling rules).
- **Templates are exact strings ported from your SKILL.md**, with one fix: the
  "Car park" template had its paragraph accidentally duplicated in the source
  file — deduped here to a single copy. The original `SKILL.md` was left
  untouched; if the duplication was intentional, let me know and I'll restore it.
- **Model:** defaults to `gemini-3.5-flash-lite` — Google's current low-latency,
  cost-effective model, explicitly positioned for high-volume classification/
  routing tasks like this one. Configurable via `GEMINI_MODEL` in `.env`.

## Not yet built (from the original handoff doc — later work)

- Airbnb/Booking.com email parsing → booking auto-entry
- Google Calendar auto-update with the existing colour/prefix coding system
- Occupancy-threshold alerts to the staff group
- Booking.com room auto-assignment logic (genuinely harder — bookings aren't
  pre-assigned to a physical unit)

## Testing before going live

Recommend testing against a **non-guest-facing test number first** (as was done
originally) before pointing this at the real Business number, especially to
validate:
1. Debounce timing feels right for real typing patterns (default 30s)
2. Reply delay (default 15s) gives staff enough — but not too much — of a window
3. The human-takeover cancellation actually fires reliably in practice

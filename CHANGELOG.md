# Changelog

Running record of major work on this system (Swiss Garden Residences operations
automation: WhatsApp guest bot, Airbnb/Booking.com email processing, checkout
smart-plug automation, bookings dashboard). Code lives here; real credentials,
guest PII, and runtime state stay out of git (see `.gitignore`).

## Infrastructure consolidation

- Collected all previously scattered project folders (`C:\Users\scada\*`,
  `C:\whatsapp-bot`, `C:\Lock\guest-passcode`, `C:\Tuya_Auto`) into a single
  `C:\apps` tree, staged as a safe copy first, then cut over live pm2 processes
  to `-v2` names once verified. Old pm2 registrations fully removed after cutover.
- Set up GitHub backup for code. Credentials/secrets stay local-only (zip backups),
  never committed - `.gitignore` excludes `.env`, `credentials.json`, `token*.json`,
  `whatsapp-bot/auth_info_baileys/`, `shared-data/` (guest PII), `backups/`, and all
  per-feature runtime state JSON files.

## WhatsApp bot fixes

- Fixed emoji/UTF-8 mojibake corruption in checkout report text.
- Fixed a duplicate-process conflict where an old pm2 registration and the new
  `-v2` one fought over the same WhatsApp session.
- Fixed bookings-dashboard's WhatsApp status/toggle buttons (were checking the
  old process name after the `-v2` rename) and several dashboard button
  click-handler bugs (stuck-loading state on error).
- Fixed Airbnb cancellation detection to parse the confirmation code from the
  email body instead of the subject line (which has a placeholder, not the
  real code).

## Gemini -> Claude migration (text intent classification)

- Guest message intent matching (WhatsApp templates) moved from Gemini to
  Claude (`claude-haiku-4-5`). Photo/video classification and audio
  transcription stay on Gemini - Claude has no audio input, and this was an
  explicit split, not a limitation worked around.
- New: `whatsapp-bot/src/claude.js`. `whatsapp-bot/src/gemini.js` trimmed to
  `classifyImage`/`transcribeAudio` only.

## New guest-service flows

- Luggage storage: guest must explicitly reply "Yes" to confirm before
  receiving the storage-room instructions + photo link; staff group is
  reminded separately to send the physical QR code.
- Extend-stay requests: forwarded straight to the staff WhatsApp group with no
  automated reply (calendar availability can't be checked automatically).
- QR-code-not-working troubleshooting: guest is asked which tower/lift they're
  at, since this is usually a wrong-lift issue rather than a broken QR.
- Assorted new mini-templates mined from real recurring guest questions:
  smoking area, ironing, towel usage, max occupancy, quiet hours, door lock
  instructions, A/C, water heater, stove, rubbish disposal, amenities, wifi.

## Gap detection

- New: `whatsapp-bot/src/gapCheck.js`. When a guest message doesn't match any
  template but Claude judges it's actually answerable from existing
  operational knowledge, an alert is written and emailed so templates can be
  added later - closes the loop on "what are we missing" without guessing.

## Airbnb chat-relay auto-reply system

Airbnb relays its in-app guest chat as email (`RE: Reservation for #NN ...`).
Replying to that email, correctly threaded, sends the reply into the guest's
Airbnb chat. Built a human-approval-gated auto-reply system:

- `email-processor/airbnbChatReply.js` scans for new guest activity, classifies
  it against `airbnbTemplates.js`/`airbnbClaude.js` (a CommonJS port of the
  WhatsApp template/Claude setup - can't share files directly, ESM vs
  CommonJS), and for a template match, posts a proposed reply to the staff
  WhatsApp group instead of sending it automatically.
- A staff member quote-replies "Proceed" on that WhatsApp message to actually
  send it. `whatsapp-bot`'s group-message handling gained one narrow
  exception for this (`handler.js`), writing an approval file that
  `email-processor` picks up, re-verifies (in case the thread was answered
  another way in the meantime), and sends via a new `sendThreadedReply` in
  `lib.js`.
- Unmatched messages and technical/maintenance issues (AC, water heater,
  stove, door lock, QR) still go straight to staff as plain alerts with the
  room number cross-referenced from the booking database where possible - no
  approval needed for those, nothing was drafted.
- No silent dry-run phase - the "Proceed" approval gate is the permanent
  safety mechanism, not a bootstrap step.

### Gmail API quota fix

Initial version fetched the full body of every active thread on every 5-minute
cycle to parse the conversation - this exhausted the Gmail API's per-minute
quota once stacked against the other Gmail-heavy cycles already running in the
same burst, and even blocked the "Proceed" approval check itself from running.
Fixed in stages, ending on an incremental design: a persisted "last scanned"
timestamp with a 1-minute overlap buffer drives an `after:<unix_timestamp>`
Gmail search, so each cycle only pulls what's genuinely new; a cheap
metadata-only fetch further filters out already-answered/stale threads before
paying for a full-body fetch. Back on the shared 5-minute cycle since the cost
is now negligible. Watermark is only advanced on success, so a mini PC
restart mid-cycle can't cause a message to be silently skipped.

Booking.com's own email-scan cycle (`detector.js`, separate from the Airbnb
chat-relay system above) was reviewed against the same quota concern and left
as-is (2026-09-07): it already only fetches cheap metadata per message
(full body only for cancellations, to get the guest name), so it was never the
source of the quota problem and doesn't need the same rework.

## Airbnb chat-relay bug fixes (2026-09-07)

A run of real-world bugs found by watching the system handle live guest
messages. Each was a case of a message being silently dropped or answered
wrongly rather than anything crashing - which is exactly why they needed
real traffic to surface:

- **Guest bubbles labelled "Guest" were unparseable.** Airbnb usually labels
  a guest's chat bubble "Booker", but sometimes uses "Guest". The parser only
  knew "Booker", so those messages parsed to zero bubbles and were recorded as
  "skipped-unparseable" - staff never saw them.
- **Emoji reactions triggered replies.** A guest tapping 👍 on a past message
  appears in the digest as `Reacted 👍 to "<quoted message>"`, which was being
  classified and proposed as a "You're most welcome!" reply. Now skipped
  before classification.
- **Pre-check-in questions treated as faults.** "Is the aircon centralised?"
  asked weeks before arrival matched `ac_not_working` and raised an urgent
  technical-issue alert with a room lookup. Technical topics are now only
  escalated once the guest has actually checked in; before that they're
  forwarded to staff as a plain query, with the auto-reply suppressed (such
  messages tend to be compound questions other templates also mismatch).
- **extend_stay requests went completely silent.** The template deliberately
  has no reply text (a human must check the calendar), but airbnbChatReply.js
  never had the branch to forward it - so it fell out of every check and was
  recorded as "no-action". Now forwarded to staff explicitly.
- **Every message after the first auto-reply on a thread was swallowed.** The
  "has this already been answered?" check compared against our own last
  checkpoint rather than the guest's newest message, so once any reply had
  been sent on a thread, every later guest message on it looked already-
  answered. Fixed to compare against the newest guest message, matching the
  already-correct logic in the approval re-verification path.
- **early_arrival_qr vs qr_not_working mismatch.** A guest asking to share the
  lobby QR with someone joining them was answered with wrong-tower-lift
  troubleshooting. The template's match condition only covered "arriving
  early"; broadened to cover sharing a QR for lobby access.

## Airbnb check-out photos and multi-bubble messages (2026-09-13)

Two bugs in one real thread: guest FAZILAH wrote "Hi, we check out already.
Thanks 😉" and then sent three room-condition photos. Staff saw only the
photos, and the images were read as identity documents.

- **Only the last chat bubble was read.** `guestText` was
  `bubbles[bubbles.length - 1]`, so when a guest sends words *and then*
  images, the digest ends in "Image sent" and the actual sentence was thrown
  away before classification. Now every *consecutive newest* guest bubble is
  joined into one message, so words and images are classified together.
- **"Image sent" was always treated as a passport.** `guest_id_received`
  described a photo "for identity verification" with no sense of timing, so
  check-out condition photos matched it and got the pre-arrival reply about
  lift QR codes and door passcodes. Guests only send ID *before* arrival;
  photos at check-out are showing the state the room was left in. The stay
  stage (before check-in / currently staying / checking out) is now computed
  from the subject-line dates and given to the classifier, `guest_id_received`
  applies only before check-in, and `checkout_confirmed` covers room-condition
  photos at or after check-out.

`whatsapp-bot/src/templates.js` was deliberately left alone: the WhatsApp path
has no stay-phase context to hand the classifier, so the same wording there
would only make it reject genuine passport photos. The two template files stay
intentionally divergent on this point.

Verified read-only against the live thread before deploying (the combined
bubbles now yield the full message, and the stay stage resolves to "checking
out") plus four stay-phase classification cases: a bare image before check-in
and passport wording before check-in both still match `guest_id_received`; a
bare image and the full Fazilah message at check-out both match
`checkout_confirmed`. A bare image *mid-stay* classifies as `room_cleaning`,
which is a guess rather than a correct read - harmless only because every
Airbnb reply is gated behind staff "Proceed" approval.

## Restart resilience (2026-09-08)

Nothing on this machine started automatically after a Windows restart - not
pm2 (all 5 services) and not the Chrome instance the Booking.com scraper
depends on. A reboot from a Windows update or power cut left the entire
operation down until someone noticed and started it by hand.

- `startup-boot.ps1` + a logon-triggered scheduled task (`SwissGarden-Startup`)
  now run `pm2 resurrect` (restoring the process list saved by `pm2 save`) and
  relaunch Chrome with its original localhost-only debug port and the same
  profile that holds the Booking.com login. Everything is logged to
  `startup-boot.log` so a failed restart can be diagnosed afterwards instead of
  silently staying down.
- Separately, `C:\Claude\start-claude.bat` (outside this repo, machine-specific)
  is launched from the Windows Startup folder to reopen an interactive Claude
  Code session at logon. It runs `cd /d C:\claude_folder` first because Claude
  Code stores sessions per working directory - `--continue` only finds the
  right session history when started from there.

## Error-logging audit and safety net (2026-09-07)

Reviewed all 5 live pm2 services for error-handling/crash-visibility coverage.
Baseline: pm2 already auto-captures all stdout/stderr to per-process log files
and auto-restarts on crash, regardless of in-app handling. On top of that,
each service already has per-cycle/per-route/per-message `try/catch` around
its main logic. The one gap: none had a global `uncaughtException`/
`unhandledRejection` handler, so a stray error outside an existing try/catch
could crash with an unlabeled stack trace, or in some cases fail silently
without a clear restart signal. Added a consistent handler to all 5 entry
points (`bookings-dashboard/server.js`, `email-processor/detector.js`,
`scraper-service/scraper-service.js`, `tuya-auto/checkout-switch-scan.js`,
`whatsapp-bot/src/index.js`) that logs clearly with the process name (for
easy grepping) before exiting, letting pm2's existing auto-restart take over.

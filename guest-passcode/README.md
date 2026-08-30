# Guest Passcode Button — Integration Module

## What this is

The single function the dashboard's "generate passcode" button should call.
Given a unit, guest name, and check-in/out dates, it creates a lock passcode
(Tuya or TTLock, auto-detected) and drops a WhatsApp message into the
existing outbox folder. Nothing else - no DB access, no UI, no code deletion.

## Files

| File | Purpose |
|---|---|
| `create-guest-passcode.js` | The main function - `createGuestPasscode(unit, guestName, checkInDate, checkOutDate)` |
| `devices.json` | Combined Tuya + TTLock unit lookup, 20 of 21 units (see "Not yet included" below) |
| `tuya-lib.js` | Copy of the working, tested Tuya lock functions |
| `ttlock-lib.js` | Copy of the working, tested TTLock lock functions |

## How to wire this into the dashboard

```js
const { createGuestPasscode } = require('./create-guest-passcode.js');

// In your button's route handler, after reading the booking from bookings.db:
app.post('/api/bookings/:id/generate-passcode', async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

  try {
    const result = await createGuestPasscode(
      booking.assigned_room,   // e.g. "S1503" - must match devices.json unit codes
      booking.guest_name,
      booking.check_in_date,   // "YYYY-MM-DD"
      booking.check_out_date   // "YYYY-MM-DD"
    );
    res.json({ success: true, passcode: result.passcode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
```

## TODOs before this is fully live (all clearly marked with `TODO` in the code)

1. **The actual WhatsApp message template** - `buildMessage()` currently has
   a reasonable placeholder. Swap in the real template once you have it.
2. **Which WhatsApp group** - `GUEST_PASSCODE_GROUP_JID` is currently a
   placeholder (`REPLACE_ME@g.us`). Set this via env var or edit directly -
   is this the same `staffGroupJid` from the whatsapp-bot's `config.js`
   (`120363405393193359@g.us`), or a different group entirely?
3. **`OUTBOX_DIR` must match** whatever the whatsapp-bot's `config.js` has
   for `outboxDir` on the actual deployment machine (defaults to
   `C:\Users\scada\wa-outbox` in both places, so likely fine as-is, but
   worth double-checking they're pointed at the identical path).
4. **Not yet included in `devices.json`: the new unit you're adding next
   week.** See below for how to add it once its lock is set up.
5. **The Tuya commercial-licensing conversation is still unresolved** (see
   the Tuya chat) - relevant since this function will be creating real
   guest passcodes.

## Adding a new unit (e.g. next week's new room)

Add one entry to `devices.json`'s `units` array:

```json
{ "unit": "S1234", "system": "tuya", "lock_device_id": "THE_DEVICE_ID" }
```
or
```json
{ "unit": "S1234", "system": "ttlock", "lock_id": 12345678 }
```

Get the `lock_device_id`/`lock_id` the same way the other 20 units were
found - see `tuya-lock-final/README.md` or `ttlock-final/README.md` for the
exact steps (link the device/share the eKey, then run the respective
`index.js` test script to read back its ID).

No code changes needed - just this one data entry.

## What's explicitly OUT of scope for this module

- Deleting/expiring old passcodes when a guest checks out
- Any database reads/writes
- The dashboard button itself, or any UI
- Email-based passcode delivery (mentioned as a possible future addition,
  not built now)
- Daily battery-level scanning (discussed separately, not yet built -
  would be a good candidate for its own small script reusing `tuya-lib.js`
  and `ttlock-lib.js`'s existing status-check functions)

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const lib = require('../email-processor/lib');
const syncService = require('../email-processor/sync-service');

process.on('uncaughtException', (err) => {
  console.error(`[FATAL][bookings-dashboard] Uncaught exception:`, err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL][bookings-dashboard] Unhandled rejection:`, reason);
  process.exit(1);
});

// Guest lock passcode generation - lives in a separate folder (C:\Lock\guest-passcode)
// outside this project, since it was built/tested independently. Loaded defensively
// so a missing/misconfigured lock module doesn't take down the whole dashboard - the
// passcode routes just report "not available" instead of crashing on startup.
const LOCK_MODULE_PATH = process.env.LOCK_MODULE_PATH || 'C:\\apps\\guest-passcode\\create-guest-passcode.js';
let createGuestPasscode = null;
try {
  ({ createGuestPasscode } = require(LOCK_MODULE_PATH));
} catch (err) {
  console.error(`[passcode] Lock module not loaded from ${LOCK_MODULE_PATH}: ${err.message}`);
}

const app = express();
const PORT = 3003;
const DB_PATH = 'C:\\apps\\shared-data\\bookings.db';
const USERS_FILE = path.join(__dirname, 'users.json');

const ROOM_POOLS = {
  'Normal Room': 12,
  'Double Bedroom': 9,
  'Small Room': 1,
};

const ROOM_REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, 'physical-room-registry.json'), 'utf8'));

function getCandidateRooms(category) {
  if (category === 'Double Bedroom') {
    return [...ROOM_REGISTRY['Double Bedroom'].dedicated, ...Object.keys(ROOM_REGISTRY['Double Bedroom'].airbnbShared)];
  }
  return ROOM_REGISTRY[category] || [];
}
const TOTAL_CAPACITY = Object.values(ROOM_POOLS).reduce((a, b) => a + b, 0);
const ALMOST_FULL_THRESHOLD = 2;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'swiss-garden-dashboard-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

function getUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

// Revenue figures are admin-only. 403 (not 401) so the page can tell "you're
// logged in but not allowed" apart from "your session expired".
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  return next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user = users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = { username: user.username, role: user.role };
  res.json({ status: 'ok', user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ status: 'ok' }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  res.status(401).json({ error: 'Not logged in' });
});

// --- Room maintenance log ---------------------------------------------------
// Every physical unit, flattened from the room registry. The registry's
// "airbnbShared" maps room -> Airbnb listing number, so the KEYS are real
// rooms and the values are listing ids - taking values here would put "06"
// and "08" in the unit list.
function allPhysicalRooms() {
  const rooms = new Set();
  for (const value of Object.values(ROOM_REGISTRY)) {
    if (Array.isArray(value)) {
      value.forEach((r) => rooms.add(r));
    } else {
      (value.dedicated || []).forEach((r) => rooms.add(r));
      Object.keys(value.airbnbShared || {}).forEach((r) => rooms.add(r));
    }
  }
  return [...rooms].sort();
}

app.get('/api/rooms', requireAuth, (req, res) => {
  res.json({ rooms: allPhysicalRooms() });
});

app.get('/api/maintenance', requireAuth, (req, res) => {
  const { room, from, to, status } = req.query;
  const where = [];
  const params = [];
  if (room) { where.push('room_number = ?'); params.push(room); }
  if (from) { where.push('event_date >= ?'); params.push(from); }
  if (to) { where.push('event_date <= ?'); params.push(to); }
  if (status) { where.push('status = ?'); params.push(status); }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT * FROM maintenance_records
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY event_date DESC, id DESC
    `).all(...params);

    const openCount = rows.filter((r) => r.status === 'open').length;
    res.json({ rows, counts: { total: rows.length, open: openCount, done: rows.length - openCount } });
  } catch (err) {
    console.error('[maintenance] list failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.post('/api/maintenance', requireAuth, (req, res) => {
  const { room_number, event_date, category, description, notes, status } = req.body;
  if (!room_number || !event_date || !description || !String(description).trim()) {
    return res.status(400).json({ error: 'room_number, event_date and description are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date)) {
    return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
  }
  // Guard against typo'd unit numbers silently creating a phantom room whose
  // history then never shows up when filtering by the real one.
  if (!allPhysicalRooms().includes(room_number)) {
    return res.status(400).json({ error: `Unknown room "${room_number}"` });
  }

  const db = new Database(DB_PATH);
  try {
    const info = db.prepare(`
      INSERT INTO maintenance_records
        (room_number, event_date, category, description, status, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      room_number,
      event_date,
      category || null,
      String(description).trim(),
      status === 'done' ? 'done' : 'open',
      notes || null,
      req.session.user.username
    );
    res.json({ status: 'ok', id: info.lastInsertRowid });
  } catch (err) {
    console.error('[maintenance] create failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.put('/api/maintenance/:id', requireAuth, (req, res) => {
  const b = req.body;
  const db = new Database(DB_PATH);
  try {
    const existing = db.prepare('SELECT * FROM maintenance_records WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    // Same merge rule as bookings: only overwrite what was actually sent, so
    // "mark as done" from the list can't blank the description.
    const merged = {
      room_number: b.room_number !== undefined ? b.room_number : existing.room_number,
      event_date: b.event_date !== undefined ? b.event_date : existing.event_date,
      category: b.category !== undefined ? b.category : existing.category,
      description: b.description !== undefined ? b.description : existing.description,
      status: b.status !== undefined ? b.status : existing.status,
      notes: b.notes !== undefined ? b.notes : existing.notes,
    };
    if (!allPhysicalRooms().includes(merged.room_number)) {
      return res.status(400).json({ error: `Unknown room "${merged.room_number}"` });
    }

    db.prepare(`
      UPDATE maintenance_records SET
        room_number = ?, event_date = ?, category = ?, description = ?,
        status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      merged.room_number, merged.event_date, merged.category,
      merged.description, merged.status, merged.notes, req.params.id
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[maintenance] update failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// Deleting is admin-only: staff can log and resolve records, but removing
// history outright is a bigger action than this log is meant to allow.
app.delete('/api/maintenance/:id', requireAdmin, (req, res) => {
  const db = new Database(DB_PATH);
  try {
    const info = db.prepare('DELETE FROM maintenance_records WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Record not found' });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[maintenance] delete failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// --- Revenue reporting (admin only) ----------------------------------------
// Rows are filtered by CHECK-OUT date: revenue is recognised when the stay
// completes, which is also how the platforms pay out.
app.get('/api/revenue', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT booking_number, platform, guest_name, check_in, check_out, assigned_room,
             status, currency, room_fee, tax_amount, gross_amount, platform_fee,
             net_payout, financials_source, financials_updated_at
      FROM bookings
      WHERE check_out >= ? AND check_out <= ? AND status != 'cancelled'
      ORDER BY check_out, booking_number
    `).all(from, to);

    const withData = rows.filter((r) => r.gross_amount != null);
    const sum = (k) => +withData.reduce((a, r) => a + (r[k] || 0), 0).toFixed(2);

    const byPlatform = {};
    for (const r of rows) {
      const p = r.platform || 'unknown';
      if (!byPlatform[p]) byPlatform[p] = { bookings: 0, withFinancials: 0, gross: 0, tax: 0, platformFee: 0, net: 0 };
      byPlatform[p].bookings++;
      if (r.gross_amount != null) {
        byPlatform[p].withFinancials++;
        byPlatform[p].gross += r.gross_amount || 0;
        byPlatform[p].tax += r.tax_amount || 0;
        byPlatform[p].platformFee += r.platform_fee || 0;
        byPlatform[p].net += r.net_payout || 0;
      }
    }
    for (const p of Object.values(byPlatform)) {
      for (const k of ['gross', 'tax', 'platformFee', 'net']) p[k] = +p[k].toFixed(2);
    }

    res.json({
      from,
      to,
      totals: {
        bookings: rows.length,
        withFinancials: withData.length,
        // Surfaced so the page can show coverage honestly rather than implying
        // these totals represent every booking in the range.
        missingFinancials: rows.length - withData.length,
        gross: sum('gross_amount'),
        tax: sum('tax_amount'),
        platformFee: sum('platform_fee'),
        net: sum('net_payout'),
      },
      byPlatform,
      rows,
    });
  } catch (err) {
    console.error('[revenue] query failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.get('/api/bookings', requireAuth, (req, res) => {
  const db = new Database(DB_PATH);
  const rows = db.prepare('SELECT * FROM bookings ORDER BY check_in').all();
  db.close();
  res.json(rows);
});

function generateOfflineCode(guestName, checkIn, db) {
  const words = (guestName || '').trim().split(/\s+/).filter(Boolean);
  let initials;
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0]).toUpperCase();
  } else if (words.length === 1) {
    initials = words[0].slice(0, 2).toUpperCase().padEnd(2, 'X');
  } else {
    initials = 'XX';
  }

  const [y, m, d] = (checkIn || '').split('-');
  const datePart = y ? `${y.slice(2)}${m}${d}` : '000000';
  const base = `${initials}${datePart}`;

  // Handle collisions (e.g. two guests with the same initials on the same day)
  // by appending A, B, C... until a free code is found.
  let candidate = base;
  let suffix = 0;
  while (db.prepare('SELECT 1 FROM bookings WHERE booking_number = ?').get(candidate)) {
    candidate = base + String.fromCharCode(65 + suffix);
    suffix++;
  }
  return candidate;
}

// Blank/absent money inputs must become NULL ("not recorded"), never 0 -
// a recorded zero and an unknown amount mean different things on the
// revenue page, which counts rows with no gross_amount as missing data.
function money(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Manual bookings are entered by hand, so the figures are whatever the user
// typed. Fee is stored negative to match how the platform scrapers store it,
// so the revenue columns can still be summed directly.
function financialsFromBody(b) {
  const gross = money(b.gross_amount);
  const tax = money(b.tax_amount);
  let fee = money(b.platform_fee);
  if (fee != null && fee > 0) fee = -fee;
  let net = money(b.net_payout);
  if (net == null && gross != null) net = +(gross - Math.abs(fee || 0)).toFixed(2);
  const anyProvided = [gross, tax, fee, net].some((v) => v != null);
  return { gross, tax, fee, net, anyProvided };
}

app.post('/api/bookings', requireAuth, (req, res) => {
  const b = req.body;
  const db = new Database(DB_PATH);
  const bookingNumber = b.booking_number || generateOfflineCode(b.guest_name, b.check_in, db);
  const f = financialsFromBody(b);

  const stmt = db.prepare(`
    INSERT INTO bookings (
      booking_number, platform, room_category, room_number,
      guest_name, check_in, check_out, status, notes, updated_at,
      currency, gross_amount, tax_amount, platform_fee, net_payout,
      financials_source, financials_updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP,
            ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_number) DO UPDATE SET
      room_category = excluded.room_category,
      room_number = excluded.room_number,
      guest_name = excluded.guest_name,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      status = excluded.status,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP,
      currency = excluded.currency,
      gross_amount = excluded.gross_amount,
      tax_amount = excluded.tax_amount,
      platform_fee = excluded.platform_fee,
      net_payout = excluded.net_payout,
      financials_source = excluded.financials_source,
      financials_updated_at = excluded.financials_updated_at
  `);
  stmt.run(
    bookingNumber,
    b.platform || 'manual',
    b.room_category || null,
    b.room_number || null,
    b.guest_name || null,
    b.check_in || null,
    b.check_out || null,
    b.status || 'new',
    b.notes || null,
    f.anyProvided ? (b.currency || 'MYR') : null,
    f.gross,
    f.tax,
    f.fee,
    f.net,
    f.anyProvided ? 'manual' : null,
    f.anyProvided ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
  );
  db.close();
  res.json({ status: 'ok', booking_number: bookingNumber });
});

app.put('/api/bookings/:bookingNumber', requireAuth, (req, res) => {
  const b = req.body;
  const db = new Database(DB_PATH);

  const existing = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(req.params.bookingNumber);
  if (!existing) {
    db.close();
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Only overwrite fields that were actually included in the request body.
  // This prevents partial updates (like saving just a note) from accidentally
  // wiping out fields the frontend didn't send, such as check_in/check_out.
  const merged = {
    room_category: b.room_category !== undefined ? b.room_category : existing.room_category,
    room_override: b.room_override !== undefined ? b.room_override : existing.room_override,
    assigned_room: b.assigned_room !== undefined ? b.assigned_room : existing.assigned_room,
    room_number: b.room_number !== undefined ? b.room_number : existing.room_number,
    guest_name: b.guest_name !== undefined ? b.guest_name : existing.guest_name,
    check_in: b.check_in !== undefined ? b.check_in : existing.check_in,
    check_out: b.check_out !== undefined ? b.check_out : existing.check_out,
    status: b.status !== undefined ? b.status : existing.status,
    notes: b.notes !== undefined ? b.notes : existing.notes,
  };

  const stmt = db.prepare(`
    UPDATE bookings SET
      room_category = ?, room_override = ?, assigned_room = ?, room_number = ?, guest_name = ?,
      check_in = ?, check_out = ?, status = ?, notes = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE booking_number = ?
  `);
  stmt.run(
    merged.room_category,
    merged.room_override,
    merged.assigned_room,
    merged.room_number,
    merged.guest_name,
    merged.check_in,
    merged.check_out,
    merged.status,
    merged.notes,
    req.params.bookingNumber
  );

  // Financials are updated separately and only when the request actually
  // carried money fields - a partial update (saving just a note, or the
  // auto-assign flow) must never blank out figures it didn't send.
  const sentMoney = ['gross_amount', 'tax_amount', 'platform_fee', 'net_payout']
    .some((k) => b[k] !== undefined);
  if (sentMoney) {
    const f = financialsFromBody(b);
    const same =
      f.gross === existing.gross_amount &&
      f.tax === existing.tax_amount &&
      f.fee === existing.platform_fee &&
      f.net === existing.net_payout;
    // Only stamp 'manual' when the numbers genuinely changed - re-saving an
    // Airbnb/Booking.com booking from the form (which pre-fills the scraped
    // values) must not relabel those figures as hand-entered.
    if (!same) {
      db.prepare(`
        UPDATE bookings SET
          currency = ?, gross_amount = ?, tax_amount = ?, platform_fee = ?, net_payout = ?,
          financials_source = 'manual', financials_updated_at = CURRENT_TIMESTAMP
        WHERE booking_number = ?
      `).run(
        b.currency || existing.currency || 'MYR',
        f.gross, f.tax, f.fee, f.net,
        req.params.bookingNumber
      );
    }
  }

  db.close();
  res.json({ status: 'ok' });
});

app.delete('/api/bookings/:bookingNumber', requireAuth, (req, res) => {
  const db = new Database(DB_PATH);
  db.prepare('DELETE FROM bookings WHERE booking_number = ?').run(req.params.bookingNumber);
  db.close();
  res.json({ status: 'ok' });
});

// Pure integer-based date helpers - no Date objects, no timezone ambiguity possible.
function isoToParts(iso) {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

function partsToIso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1];
}

// Returns the next calendar day as an ISO string, using plain integer math only.
function nextIsoDay(iso) {
  let { y, m, d } = isoToParts(iso);
  d += 1;
  if (d > daysInMonth(y, m)) {
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return partsToIso(y, m, d);
}

// Generates every ISO date string from start to end (inclusive), purely via string/integer math.
function isoDateRange(startIso, endIso) {
  const dates = [];
  let cur = startIso;
  let guard = 0;
  while (cur <= endIso && guard < 400) {
    dates.push(cur);
    cur = nextIsoDay(cur);
    guard++;
  }
  return dates;
}

// Returns every night (as ISO strings) a guest occupies a room: check-in night
// through the night before checkout. Pure string comparison, no Date objects.
function nightsBetweenIso(checkInIso, checkOutIso) {
  if (!checkInIso || !checkOutIso || checkOutIso <= checkInIso) return [];
  const nights = [];
  let cur = checkInIso;
  let guard = 0;
  while (cur < checkOutIso && guard < 400) {
    nights.push(cur);
    cur = nextIsoDay(cur);
    guard++;
  }
  return nights;
}

// Nights remaining from a given night through checkout, via pure string/integer math.
function nightsRemaining(fromIso, checkOutIso) {
  let count = 0;
  let cur = fromIso;
  let guard = 0;
  while (cur < checkOutIso && guard < 400) {
    count++;
    cur = nextIsoDay(cur);
    guard++;
  }
  return count;
}

// Given a category and date range, returns which physical rooms are genuinely
// free (checked across ALL platforms - Booking.com, Airbnb, offline - since
// they share the same 21 physical rooms). Always includes the booking's own
// currently-assigned room too, even if "occupied" (by itself).
app.get('/api/available-rooms', requireAuth, (req, res) => {
  const { category, checkIn, checkOut, currentBooking } = req.query;
  if (!category || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'category, checkIn, checkOut are required' });
  }

  const candidates = getCandidateRooms(category);
  const db = new Database(DB_PATH);

  const overlapping = db.prepare(`
    SELECT assigned_room, booking_number FROM bookings
    WHERE status != 'cancelled' AND assigned_room IS NOT NULL
    AND check_in < ? AND check_out > ?
  `).all(checkOut, checkIn);
  db.close();

  const occupiedRooms = new Set(
    overlapping.filter((r) => r.booking_number !== currentBooking).map((r) => r.assigned_room)
  );

  const available = candidates.filter((room) => !occupiedRooms.has(room));

  // For Double Bedroom, list dedicated rooms first (preferred), then Airbnb-shared ones.
  let ordered = available;
  if (category === 'Double Bedroom') {
    const dedicated = ROOM_REGISTRY['Double Bedroom'].dedicated;
    ordered = [
      ...available.filter((r) => dedicated.includes(r)),
      ...available.filter((r) => !dedicated.includes(r)),
    ];
  }

  res.json({ available: ordered });
});

// Assigns a physical room to every active, unassigned booking that overlaps the
// given date - not just fresh arrivals, so it also catches anything missed on a
// previous day. Uses the exact same overlap-checking logic as /api/available-rooms,
// per booking's own actual check_in/check_out (not just the requested date), so an
// assignment is always genuinely conflict-free for the booking's whole stay.
app.post('/api/auto-assign-day', requireAuth, (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }

  const db = new Database(DB_PATH);

  const candidates = db
    .prepare(`
      SELECT booking_number, platform, room_number, room_category, room_override, check_in, check_out FROM bookings
      WHERE status != 'cancelled' AND assigned_room IS NULL
      AND check_in <= ? AND check_out > ?
    `)
    .all(date, date);

  const assigned = [];
  const skipped = [];

  for (const booking of candidates) {
    const category = booking.room_override || booking.room_category;
    const pool = getCandidateRooms(category);
    if (!category || category === 'UNKNOWN' || pool.length === 0) {
      skipped.push({ bookingNumber: booking.booking_number, reason: `Missing/unknown room category (${category || 'none'})` });
      continue;
    }

    const overlapping = db
      .prepare(`
        SELECT assigned_room FROM bookings
        WHERE status != 'cancelled' AND assigned_room IS NOT NULL
        AND check_in < ? AND check_out > ? AND booking_number != ?
      `)
      .all(booking.check_out, booking.check_in, booking.booking_number);
    const occupied = new Set(overlapping.map((r) => r.assigned_room));

    let orderedCandidates; // priority order, first available wins - not a random pick
    if (category === 'Double Bedroom') {
      const dedicated = ROOM_REGISTRY['Double Bedroom'].dedicated;
      const airbnbShared = ROOM_REGISTRY['Double Bedroom'].airbnbShared; // { roomCode: listingTag }

      if (booking.platform === 'airbnb') {
        // Airbnb Double Bedroom bookings only ever use airbnbShared rooms, never
        // dedicated - and always prefer their OWN listing's default room first
        // (e.g. #06 -> N2206), only spilling over to another Airbnb-shared room
        // if their own is genuinely occupied by something else.
        const ownRoom = Object.keys(airbnbShared).find((room) => airbnbShared[room] === booking.room_number);
        const rest = Object.keys(airbnbShared).filter((room) => room !== ownRoom);
        orderedCandidates = ownRoom ? [ownRoom, ...rest] : rest;
      } else {
        // Booking.com/offline: dedicated rooms are the primary pool; Airbnb-shared
        // rooms are only a last-minute exception when every dedicated room is taken.
        orderedCandidates = [...dedicated, ...Object.keys(airbnbShared)];
      }
    } else {
      orderedCandidates = pool;
    }

    const available = orderedCandidates.filter((room) => !occupied.has(room));

    if (available.length === 0) {
      skipped.push({ bookingNumber: booking.booking_number, reason: `No free ${category} room for these dates` });
      continue;
    }

    // Double Bedroom has a real priority order (an Airbnb listing's own default
    // room must win outright if free), so take the first available in that order.
    // Normal/Small Room have no such preference, so pick randomly among equals.
    const room = category === 'Double Bedroom'
      ? available[0]
      : available[Math.floor(Math.random() * available.length)];
    db.prepare('UPDATE bookings SET assigned_room = ?, updated_at = CURRENT_TIMESTAMP WHERE booking_number = ?').run(
      room,
      booking.booking_number
    );
    assigned.push({ bookingNumber: booking.booking_number, room });
  }

  db.close();
  res.json({ assigned, skipped });
});

// Why a booking can't get a passcode right now - shared by both the single
// and bulk routes below so the reasons staff see are always consistent.
function passcodeEligibilityError(booking) {
  if (!booking) return 'Booking not found';
  if (booking.status === 'cancelled') return 'Booking is cancelled';
  if (!booking.assigned_room) return 'No room assigned yet';
  if (!booking.guest_name) return 'Guest name missing';
  if (!booking.check_in || !booking.check_out) return 'Missing check-in/check-out dates';
  return null;
}

// Individual "Generate Passcode" button, one booking at a time.
app.post('/api/bookings/:bookingNumber/generate-passcode', requireAuth, async (req, res) => {
  if (!createGuestPasscode) {
    return res.status(500).json({ error: 'Lock passcode module is not available on this server.' });
  }
  const db = new Database(DB_PATH);
  try {
    const booking = db.prepare('SELECT * FROM bookings WHERE booking_number = ?').get(req.params.bookingNumber);
    const eligibilityError = passcodeEligibilityError(booking);
    if (eligibilityError) {
      return res.status(400).json({ error: eligibilityError });
    }
    const result = await createGuestPasscode(booking.assigned_room, booking.guest_name, booking.check_in, booking.check_out);
    res.json({ success: true, unit: result.unit, passcode: result.passcode, system: result.system, guestName: booking.guest_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// Bulk "Generate All Passcodes" button for a whole day's worth of check-ins.
// Bookings with no assigned_room yet are skipped (not blocked) - staff sees
// exactly who was skipped and why, and can assign + retry individually.
app.post('/api/generate-passcodes-day', requireAuth, async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }
  if (!createGuestPasscode) {
    return res.status(500).json({ error: 'Lock passcode module is not available on this server.' });
  }

  const db = new Database(DB_PATH);
  let checkIns;
  try {
    checkIns = db
      .prepare("SELECT * FROM bookings WHERE check_in = ? AND status != 'cancelled'")
      .all(date);
  } finally {
    db.close();
  }

  const succeeded = [];
  const skipped = [];
  const failed = [];

  // Sequential on purpose, not Promise.all: createGuestPasscode's collision
  // ledger does a read-modify-write on issued-codes.json that isn't safe for
  // concurrent calls (two simultaneous calls could both read the ledger
  // before either writes back, silently losing one of the two entries).
  for (const booking of checkIns) {
    const eligibilityError = passcodeEligibilityError(booking);
    if (eligibilityError) {
      skipped.push({ bookingNumber: booking.booking_number, guestName: booking.guest_name, reason: eligibilityError });
      continue;
    }
    try {
      const result = await createGuestPasscode(booking.assigned_room, booking.guest_name, booking.check_in, booking.check_out);
      succeeded.push({
        bookingNumber: booking.booking_number,
        guestName: booking.guest_name,
        unit: result.unit,
        passcode: result.passcode,
        system: result.system,
      });
    } catch (err) {
      failed.push({ bookingNumber: booking.booking_number, guestName: booking.guest_name, error: err.message });
    }
  }

  res.json({ date, succeeded, skipped, failed });
});

// Manual trigger for the housekeeping checkout report - composes the exact
// same message the 9PM auto-timer would (via the shared lib.js function), and
// drops it in the same outbox for whatsapp-bot to pick up. Always allowed
// regardless of whether the 9PM auto-send already fired today - this is
// specifically for resending an updated list after a late change.
app.post('/api/send-checkout-report', requireAuth, (req, res) => {
  const db = new Database(DB_PATH);
  try {
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const message = lib.composeCheckoutReport(db, todayIso);
    lib.writeOutboxMessage(lib.CHECKOUT_REPORT_GROUP_JID, message);
    res.json({ status: 'ok', message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.get('/api/occupancy', requireAuth, (req, res) => {
  const { start, end } = req.query;
  const db = new Database(DB_PATH);
  const rows = db.prepare("SELECT * FROM bookings WHERE status != 'cancelled'").all();
  db.close();

  const dayMap = {};
  for (const dateStr of isoDateRange(start, end)) {
    dayMap[dateStr] = { total: 0, byCategory: {}, byPlatform: {}, bookings: [] };
  }

  for (const row of rows) {
    const nights = nightsBetweenIso(row.check_in, row.check_out);
    const effectiveCategory = row.room_override || row.room_category;
    for (const night of nights) {
      if (dayMap[night]) {
        dayMap[night].total += 1;
        dayMap[night].byCategory[effectiveCategory || 'Unknown'] =
          (dayMap[night].byCategory[effectiveCategory || 'Unknown'] || 0) + 1;
        const platformKey = row.platform || 'manual';
        dayMap[night].byPlatform[platformKey] = (dayMap[night].byPlatform[platformKey] || 0) + 1;

        const isCheckInThisNight = row.check_in === night;
        const remaining = nightsRemaining(night, row.check_out);
        let stayStatus;
        if (isCheckInThisNight) {
          stayStatus = 'Check-in today';
        } else if (remaining <= 1) {
          stayStatus = '(last night)';
        } else {
          stayStatus = `${remaining} nights left`;
        }

        dayMap[night].bookings.push({
          booking_number: row.booking_number,
          guest_name: row.guest_name,
          room_category: row.room_category,
          room_override: row.room_override,
          assigned_room: row.assigned_room,
          room_number: row.room_number,
          platform: row.platform,
          status: row.status,
          notes: row.notes,
          check_in: row.check_in,
          check_out: row.check_out,
          stay_status: stayStatus,
        });
      }
    }
  }

  const result = Object.entries(dayMap).map(([date, data]) => {
    const categoryBreakdown = {};
    for (const [category, capacity] of Object.entries(ROOM_POOLS)) {
      const occupied = data.byCategory[category] || 0;
      categoryBreakdown[category] = { occupied, capacity, full: occupied >= capacity };
    }
    return {
      date,
      total: data.total,
      capacity: TOTAL_CAPACITY,
      remaining: TOTAL_CAPACITY - data.total,
      almostFull: TOTAL_CAPACITY - data.total <= ALMOST_FULL_THRESHOLD,
      byCategory: categoryBreakdown,
      byPlatform: {
        'booking.com': data.byPlatform['booking.com'] || 0,
        airbnb: data.byPlatform['airbnb'] || 0,
        manual: data.byPlatform['manual'] || 0,
      },
      bookings: data.bookings,
    };
  });

  res.json({ roomPools: ROOM_POOLS, totalCapacity: TOTAL_CAPACITY, days: result });
});

app.get('/api/pending', requireAuth, (req, res) => {
  const db = lib.openDb();
  const items = lib.getPendingQueue(db);
  const counts = lib.getPendingCount(db);
  db.close();
  res.json({ counts, items });
});

app.post('/api/sync-now', requireAuth, async (req, res) => {
  const result = await syncService.runSync();
  res.json(result);
});

const { exec } = require('child_process');

function runPm2Command(command) {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

app.get('/api/whatsapp-status', requireAuth, async (req, res) => {
  try {
    const output = await runPm2Command('pm2 jlist');
    const list = JSON.parse(output);
    const proc = list.find((p) => p.name === 'whatsapp-bot-v2');
    if (!proc) {
      return res.json({ found: false, running: false });
    }
    res.json({ found: true, running: proc.pm2_env.status === 'online', status: proc.pm2_env.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp-toggle', requireAuth, async (req, res) => {
  const { action } = req.body;
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ error: 'action must be "start" or "stop"' });
  }
  try {
    await runPm2Command(`pm2 ${action} whatsapp-bot-v2`);
    res.json({ status: 'ok', action });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sync-status', requireAuth, (req, res) => {
  res.json(syncService.getSyncState());
});

app.post('/api/clear-errors', requireAuth, (req, res) => {
  const db = lib.openDb();
  const cleared = lib.clearAllErrors(db);
  db.close();
  res.json({ status: 'ok', cleared });
});

// Run the shared schema migrations once at startup. This project queries the
// database with its own `new Database(DB_PATH)` handles rather than
// lib.openDb(), so without this the maintenance table would only appear
// whenever email-detector happened to run first.
try {
  lib.openDb().close();
} catch (err) {
  console.error('[startup] schema migration failed:', err.message);
}

app.listen(PORT, () => {
  console.log(`Bookings dashboard listening on port ${PORT}`);
});

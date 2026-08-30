const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const PORT = 3002;
const CHROME_DEBUG_URL = 'http://localhost:9222';

const roomDescriptions = [
  { pattern: /Apartment with City View\s*\(\s*Premium Deluxe\s*\)/i, name: 'Normal Room', total: 11 },
  { pattern: /Two-Bedroom Apartment with View\s*\(\s*Double Room\s*\)/i, name: 'Double Bedroom', total: 9 },
  { pattern: /Apartment\s*\(\s*2\s*Kings?\s*Room\s*\)/i, name: 'Small Room', total: 1 },
];

const BLOCKED_INDICATORS = [
  /unusual traffic/i,
  /verify you.re a human/i,
  /verify you are human/i,
  /captcha/i,
  /access denied/i,
  /automated queries/i,
  /suspicious activity/i,
  /temporarily blocked/i,
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toISODate(str) {
  const m = str.match(/\w+,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const monthIndex = MONTH_NAMES.findIndex((mn) => m[1].startsWith(mn));
  if (monthIndex === -1) return null;
  const year = m[3];
  const month = String(monthIndex + 1).padStart(2, '0');
  const day = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDwellMs() {
  return Math.floor(Math.random() * 4000) + 3000;
}

// Booking.com lets a guest book multiple rooms under ONE booking number (e.g.
// "Total rooms: 2"). The single-room matcher above just checks "does this room's
// text appear anywhere on the page" and stops at the first hit - for a multi-room
// booking that silently keeps only ONE room and drops the other entirely (a real
// double-booking risk, since the dropped room never gets blocked as occupied).
// This finds every numbered room line (e.g. "1 Two-Bedroom Apartment...") and its
// own date pair - each room can have different dates if a guest extends one but
// not the other.
function parseMultiRoomItems(pageText) {
  const headerRegex = new RegExp(
    '^\\d+\\s+(' + roomDescriptions.map((r) => r.pattern.source).join('|') + ')',
    'gmi'
  );
  const headers = [];
  let hm;
  while ((hm = headerRegex.exec(pageText)) !== null) {
    const matchedRoom = roomDescriptions.find((r) => r.pattern.test(hm[0]));
    headers.push({ index: hm.index, endIndex: hm.index + hm[0].length, room: matchedRoom });
  }

  const dateRegex = /(\w+, \w+ \d+, \d{4})\s*\n?\s*(\w+, \w+ \d+, \d{4})/;
  const rooms = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].endIndex;
    const end = i + 1 < headers.length ? headers[i + 1].index : pageText.length;
    const window = pageText.slice(start, end);
    const dm = window.match(dateRegex);
    rooms.push({
      roomType: headers[i].room.name,
      categoryPoolSize: headers[i].room.total,
      checkIn: dm ? toISODate(dm[1]) : null,
      checkOut: dm ? toISODate(dm[2]) : null,
    });
  }
  return rooms;
}

app.post('/scrape', async (req, res) => {
  const { bookingLink } = req.body;

  if (!bookingLink || typeof bookingLink !== 'string' || !bookingLink.startsWith('http')) {
    return res.status(400).json({
      status: 'ERROR',
      message: 'bookingLink is missing or invalid',
      received: bookingLink,
    });
  }

  let browser;
  let page;

  try {
    browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL });
    page = await browser.newPage();
    await page.goto(bookingLink, { waitUntil: 'networkidle2', timeout: 30000 });

    await sleep(randomDwellMs());

    try {
      await page.evaluate(() => window.scrollBy(0, 200));
      await sleep(500 + Math.random() * 1000);
    } catch (e) {}

    const pageText = await page.evaluate(() => document.body.innerText);

    for (const indicator of BLOCKED_INDICATORS) {
      if (indicator.test(pageText)) {
        await page.close();
        return res.json({
          status: 'BLOCKED',
          message: 'Booking.com appears to be blocking/challenging this session. Stop and check manually.',
        });
      }
    }

    if (!pageText.includes('Booking number:')) {
      await page.close();
      return res.json({
        status: 'LOGIN_REQUIRED',
        message:
          'Reservation page did not load as expected (no "Booking number:" found) - ' +
          'likely a login prompt, 2FA/verification screen, or expired session. ' +
          'Please check the Chrome window on the mini PC.',
      });
    }

    const bookingNumberMatch = pageText.match(/Booking number:\s*\n?(\d+)/);
    // \p{L}/\p{M} (Unicode letter/combining-mark) instead of A-Za-z, so accented or
    // non-Latin guest names (e.g. "Raffael Wörner") don't silently fail to match at all -
    // the old ASCII-only class caused the WHOLE match to fail (not just truncate) the
    // moment it hit a character like "ö", since neither the name class nor the "\n"/
    // " Genius" terminator could consume it. Also allows '.', ',', '&' for names like
    // "Md. Rahman" or multiple guests "John Smith & Jane Doe".
    const guestNameMatch = pageText.match(/Guest name:\s*\n([\p{L}\p{M}\s\-'.,&]+?)(?:\n|\s+Genius)/u);

    const totalRoomsMatch = pageText.match(/Total rooms\s*\n\s*(\d+)/);
    const totalRooms = totalRoomsMatch ? parseInt(totalRoomsMatch[1], 10) : 1;

    if (totalRooms > 1) {
      const rooms = parseMultiRoomItems(pageText);

      await sleep(500 + Math.random() * 1500);
      await page.close();

      return res.json({
        status: 'OK',
        multiRoom: true,
        bookingNumber: bookingNumberMatch ? bookingNumberMatch[1] : null,
        guestName: guestNameMatch ? guestNameMatch[1].trim() : null,
        rooms,
      });
    }

    let matchedRoom = null;
    for (const room of roomDescriptions) {
      if (room.pattern.test(pageText)) {
        matchedRoom = room;
        break;
      }
    }

    // Modified bookings show a change-history log (e.g. "check-out date has
    // been changed" with old/new values) BEFORE the actual reservation
    // details further down the page. Both look like date pairs to a simple
    // regex, so take the LAST match on the page - the real details always
    // render after any change-history entries.
    const dateRegex = /(\w+, \w+ \d+, \d{4})\s*\n?\s*(\w+, \w+ \d+, \d{4})/g;
    let dateMatch = null;
    let m;
    while ((m = dateRegex.exec(pageText)) !== null) {
      dateMatch = m;
    }

    await sleep(500 + Math.random() * 1500);
    await page.close();

    return res.json({
      status: 'OK',
      multiRoom: false,
      bookingNumber: bookingNumberMatch ? bookingNumberMatch[1] : null,
      guestName: guestNameMatch ? guestNameMatch[1].trim() : null,
      roomType: matchedRoom ? matchedRoom.name : 'UNKNOWN',
      categoryPoolSize: matchedRoom ? matchedRoom.total : null,
      checkIn: dateMatch ? toISODate(dateMatch[1]) : null,
      checkOut: dateMatch ? toISODate(dateMatch[2]) : null,
    });
  } catch (err) {
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'scraper-service' });
});

app.listen(PORT, () => {
  console.log(`Scraper service listening on port ${PORT}`);
});

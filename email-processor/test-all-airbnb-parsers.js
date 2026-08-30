const fs = require('fs');

const ROOM_MAP = {
  '01': 'Normal Room', '02': 'Normal Room', '03': 'Normal Room', '04': 'Normal Room',
  '05': 'Normal Room', '07': 'Normal Room', '09': 'Normal Room', '14': 'Normal Room',
  '06': 'Double Bedroom', '08': 'Double Bedroom', '10': 'Double Bedroom',
  '11': 'Double Bedroom', '12': 'Double Bedroom',
  '15': 'Double Bedroom', '16': 'Double Bedroom',
};

function extractRoomNumber(text) {
  const match = text.match(/#(\d{1,2})\s+#Swiss Garden/i);
  return match ? match[1].padStart(2, '0') : null;
}

function roomCategoryFor(roomNumber) {
  if (!roomNumber) return null;
  return ROOM_MAP[roomNumber] || 'UNKNOWN';
}

function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inferYear(monthDayStr, receivedDate) {
  const cleaned = monthDayStr.replace(/^\w{3},\s*/, '');
  const received = new Date(receivedDate);
  const candidateThisYear = new Date(`${cleaned}, ${received.getFullYear()}`);
  if (candidateThisYear < received) {
    return new Date(`${cleaned}, ${received.getFullYear() + 1}`);
  }
  return candidateThisYear;
}

function parseNewBooking(subject, text, receivedDate) {
  const subjectMatch = subject.match(/^Reservation confirmed - (.+) arrives (\w+ \d+)$/);
  if (!subjectMatch) return null;

  const guestName = subjectMatch[1];
  const codeMatch = text.match(/CONFIRMATION CODE\s*\n(\S+)/i) || text.match(/reservations\/details\/([A-Z0-9]+)/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;
  const roomNumber = extractRoomNumber(text);

  const dateMatch = text.match(/Check-in\s+Checkout[\s\S]*?(\w{3}, \w{3} \d{1,2})\s+(\w{3}, \w{3} \d{1,2})/);
  let checkIn = null;
  let checkOut = null;
  if (dateMatch) {
    checkIn = inferYear(dateMatch[1], receivedDate);
    checkOut = inferYear(dateMatch[2], receivedDate);
  }

  return {
    type: 'NEW',
    confirmationCode,
    guestName,
    roomNumber,
    roomCategory: roomCategoryFor(roomNumber),
    checkIn: checkIn ? toLocalISODate(checkIn) : null,
    checkOut: checkOut ? toLocalISODate(checkOut) : null,
  };
}

function parseCancellation(subject) {
  const match = subject.match(/^Canceled: Reservation (\S+) for/);
  if (!match) return null;
  return { type: 'CANCELLED', confirmationCode: match[1] };
}

function parseChangeRequest(subject, text, receivedDate) {
  const subjectMatch = subject.match(/^(.+) wants to change their reservation$/);
  if (!subjectMatch) return null;

  const guestName = subjectMatch[1];
  const roomNumber = extractRoomNumber(text);

  if (text.includes('REQUESTED DATES')) {
    const dateMatch = text.match(
      /REQUESTED DATES\s*\n\s*\n?(\w+ \d{1,2}, \d{4})\s*-\s*(\w+ \d{1,2}, \d{4})/
    );
    return {
      type: 'CHANGE_REQUEST_DATES',
      guestName,
      roomNumber,
      requestedCheckIn: dateMatch ? toLocalISODate(new Date(dateMatch[1])) : null,
      requestedCheckOut: dateMatch ? toLocalISODate(new Date(dateMatch[2])) : null,
      receivedDate,
    };
  }

  if (text.includes('REQUESTED GUESTS')) {
    return { type: 'CHANGE_REQUEST_GUESTS_ONLY', guestName, roomNumber };
  }

  return { type: 'CHANGE_REQUEST_UNKNOWN', guestName, roomNumber };
}

function parseUpdateConfirmed(text) {
  const nameMatch = text.match(/YOUR RESERVATION WITH (.+) HAS BEEN UPDATED/i);
  if (!nameMatch) return null;

  const guestName = nameMatch[1];
  const roomNumber = extractRoomNumber(text);
  const codeMatch = text.match(/reservations\/details\/([A-Z0-9]+)/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;

  return { type: 'UPDATE_CONFIRMED', guestName, roomNumber, confirmationCode };
}

console.log('=== NEW booking ===');
const newText = fs.readFileSync('./debug-airbnb-body.txt', 'utf8');
console.log(parseNewBooking('Reservation confirmed - Saadman Tahmid arrives Aug 5', newText, '2026-07-29'));

console.log('\n=== CANCELLED ===');
console.log(parseCancellation('Canceled: Reservation HMJAA2TZM8 for Jul 25 – 26, 2026'));

console.log('\n=== CHANGE REQUEST (guests only, should be ignored) ===');
const changeGuestsText = fs.readFileSync('./sample-change-request.txt', 'utf8');
console.log(parseChangeRequest('Tim wants to change their reservation', changeGuestsText, '2026-07-27'));

console.log('\n=== CHANGE REQUEST (dates) ===');
const changeDatesText = fs.readFileSync('./sample-change-request-dates.txt', 'utf8');
console.log(parseChangeRequest('Desy wants to change their reservation', changeDatesText, '2026-07-27'));

console.log('\n=== UPDATE CONFIRMED ===');
const updateText = fs.readFileSync('./sample-update-confirmed.txt', 'utf8');
console.log(parseUpdateConfirmed(updateText));

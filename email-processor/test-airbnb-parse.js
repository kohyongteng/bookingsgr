const fs = require('fs');

function inferYear(monthDayStr, receivedDate) {
  const cleaned = monthDayStr.replace(/^\w{3},\s*/, '');
  const received = new Date(receivedDate);
  const candidateThisYear = new Date(`${cleaned}, ${received.getFullYear()}`);

  if (candidateThisYear < received) {
    return new Date(`${cleaned}, ${received.getFullYear() + 1}`);
  }
  return candidateThisYear;
}

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

function parseNewBooking(subject, text, receivedDate) {
  const subjectMatch = subject.match(/^Reservation confirmed - (.+) arrives (\w+ \d+)$/);
  if (!subjectMatch) return null;

  const guestName = subjectMatch[1];

  const codeMatch = text.match(/CONFIRMATION CODE\s*\n(\S+)/i) || text.match(/reservations\/details\/([A-Z0-9]+)/);
  const confirmationCode = codeMatch ? codeMatch[1] : null;

  const roomNumber = extractRoomNumber(text);
  const roomCategory = roomNumber ? ROOM_MAP[roomNumber] || 'UNKNOWN' : null;

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
    roomNumber: roomNumber ? '#' + roomNumber : null,
    roomCategory,
    checkIn: checkIn ? checkIn.toDateString() : null,
    checkOut: checkOut ? checkOut.toDateString() : null,
  };
}

const subject = 'Reservation confirmed - Saadman Tahmid arrives Aug 5';
const text = fs.readFileSync('./debug-airbnb-body.txt', 'utf8');
const receivedDate = '2026-07-29T00:00:00.000Z';

const result = parseNewBooking(subject, text, receivedDate);
console.log('Parsed result:');
console.log(result);
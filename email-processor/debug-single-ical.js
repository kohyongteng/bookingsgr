const fs = require('fs');
const roomMap = JSON.parse(fs.readFileSync('./airbnb-ical-map.json', 'utf8'));

(async () => {
  const url = roomMap['01'];
  const res = await fetch(url);
  console.log('Status:', res.status, res.statusText);
  const text = await res.text();
  console.log('Response length:', text.length);
  console.log('\n--- First 500 chars ---');
  console.log(text.slice(0, 500));
})();

fetch("https://www.airbnb.com/calendar/ical/1266484231714730283.ics?t=ab80249e6b1b40cdbc01b21df9353e10")
  .then(res => res.text())
  .then(text => {
    require('fs').writeFileSync('./sample-room01.ics', text);
    console.log('Saved sample-room01.ics');
    console.log('Length:', text.length);
    console.log('\n--- First 2000 chars ---');
    console.log(text.slice(0, 2000));
  })
  .catch(err => console.error('Fetch error:', err.message));

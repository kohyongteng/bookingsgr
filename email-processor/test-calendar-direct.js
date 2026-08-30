const lib = require('./lib');
(async () => {
  const cal = lib.getCalendarClient('airbnb');
  try {
    const res = await cal.calendarList.list();
    console.log('SUCCESS - calendars found:', res.data.items.map(c => c.summary));
  } catch (err) {
    console.log('ERROR:', err.message);
  }
})();

// Read-only diagnostic - dumps the raw scraped page text for the 2-room booking,
// so the multi-room parser can be written against real formatting instead of
// guessing. Does not touch the database at all.
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
  const page = await browser.newPage();
  const link = 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=5827500092&hotel_id=11643095&lang=en-us';
  await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  const pageText = await page.evaluate(() => document.body.innerText);
  require('fs').writeFileSync('./booking-5827500092-page.txt', pageText);

  console.log('Full page text saved to booking-5827500092-page.txt');

  await page.close();
})();

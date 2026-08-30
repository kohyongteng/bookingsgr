const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
  const page = await browser.newPage();
  const link = 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=6909058009&hotel_id=11643095&lang=en-us';
  await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const pageText = await page.evaluate(() => document.body.innerText);
  require('fs').writeFileSync('./booking-6909058009-page.txt', pageText);

  // Find EVERY date-pair match on the page, not just the first
  const regex = /(\w+, \w+ \d+, \d{4})\s*\n?\s*(\w+, \w+ \d+, \d{4})/g;
  let match;
  let count = 0;
  while ((match = regex.exec(pageText)) !== null) {
    count++;
    console.log(`Match ${count}: "${match[1]}" -> "${match[2]}"`);
    console.log('Context:', pageText.slice(Math.max(0, match.index - 80), match.index + 100));
    console.log('---');
  }
  console.log(`\nTotal date-pair matches found: ${count}`);
  console.log('Full page text saved to booking-6909058009-page.txt');

  await page.close();
})();

// compare-lock-detail.js
//
// Pulls TTLock's /v3/lock/detail for two locks - the new S2103 (China-bought,
// different model) and S1503 (the original confirmed-working reference lock
// per ttlock-lib.js's own header comment) - and prints both side by side so
// we can spot any real difference (protocol version, keyboardPwdVersion,
// etc.) rather than guessing.
//
// Usage (in C:\Lock\guest-passcode, next to ttlock-lib.js):
//   node compare-lock-detail.js

const ttlock = require('./ttlock-lib.js');
const devices = require('./devices.json');
const https = require('https');

async function main() {
  const accessToken = await ttlock.getAccessToken();

  const newLock = devices.units.find((u) => u.unit === 'S2103');
  const knownGood = devices.units.find((u) => u.unit === 'S1503');

  console.log('Comparing:');
  console.log(`  New (China-bought) : S2103, lockId ${newLock.lock_id}`);
  console.log(`  Known-working       : S1503, lockId ${knownGood.lock_id}`);
  console.log('');

  // Using the library's internal request helper directly since lock/detail
  // isn't exposed as its own function yet.
  function rawGet(path, params) {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams(params).toString();
      https.get(`https://euapi.ttlock.com${path}?${query}`, { headers: { Connection: 'close' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  const clientId = process.env.TTLOCK_CLIENT_ID;

  const [newDetail, goodDetail] = await Promise.all([
    rawGet('/v3/lock/detail', { clientId, accessToken, lockId: newLock.lock_id, date: Date.now().toString() }),
    rawGet('/v3/lock/detail', { clientId, accessToken, lockId: knownGood.lock_id, date: Date.now().toString() }),
  ]);

  console.log('=== S2103 (new) lock detail ===');
  console.log(JSON.stringify(newDetail, null, 2));
  console.log('\n=== S1503 (known-working) lock detail ===');
  console.log(JSON.stringify(goodDetail, null, 2));

  console.log('\n=== Key fields side by side ===');
  const fields = ['lockVersion', 'keyboardPwdVersion', 'lockAlias', 'featureValue', 'noKeyPwd', 'specialValue'];
  for (const f of fields) {
    console.log(`${f.padEnd(20)} new: ${JSON.stringify(newDetail[f])}   known-working: ${JSON.stringify(goodDetail[f])}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

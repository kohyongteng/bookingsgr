// list-ttlock-locks.js
//
// Lists all locks visible on your TTLock account, with their numeric
// lockId - use this to find the ID for the newly-switched S2103 door.
//
// Place in C:\Lock\guest-passcode\ (next to ttlock-lib.js) and run:
//   node list-ttlock-locks.js

const ttlock = require('./ttlock-lib.js');

async function main() {
  const accessToken = await ttlock.getAccessToken();
  const result = await ttlock.listKeys(accessToken);

  const list = result.list || result; // handle either shape defensively
  if (!Array.isArray(list) || list.length === 0) {
    console.log('No locks found. Raw response:');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Found ${list.length} lock(s):\n`);
  for (const item of list) {
    console.log(`lockName: ${item.lockName}`);
    console.log(`lockId  : ${item.lockId}`);
    console.log('---');
  }
  console.log('\nFind the one named for S2103 above, then use its lockId in devices.json.');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

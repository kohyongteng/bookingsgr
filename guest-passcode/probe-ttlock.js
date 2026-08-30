// probe-ttlock.js
//
// Standalone, read-only TTLock API diagnostic. Runs a sequence of probes
// against a target lock and (optionally) a known-working reference lock,
// printing the RAW API response for each so nothing is hidden or guessed.
//
// Nothing here writes to a lock, creates a passcode, or changes settings.
// The only "live" probe is queryDate, which asks the lock what time it
// thinks it is - a successful reply proves the full
// cloud -> gateway -> lock chain is working AT THIS MOMENT.
//
// Usage (in C:\Lock\guest-passcode, next to ttlock-lib.js and .env):
//   node probe-ttlock.js                  # probes S2103 vs S1503
//   node probe-ttlock.js S2103            # probe one unit only
//   node probe-ttlock.js S2103 S1503      # explicit target + reference
//
// Some endpoints below may return an error for a given account/lock -
// that is itself useful information, so the script prints whatever comes
// back rather than swallowing it.

require('dotenv').config();
const https = require('https');
const ttlock = require('./ttlock-lib.js');
const devices = require('./devices.json');

const HOST = 'euapi.ttlock.com';

// ---------------- low-level request (mirrors ttlock-lib.js's approach:
// no keep-alive, explicit Connection: close - the combination that fixed
// "Premature close" errors on Windows) ----------------
function apiGet(path, params) {
  return new Promise((resolve) => {
    const query = new URLSearchParams(params).toString();
    const options = {
      hostname: HOST,
      path: `${path}?${query}`,
      method: 'GET',
      headers: { Connection: 'close', 'User-Agent': 'TTLockProbe/1.0' },
      agent: new https.Agent({ keepAlive: false }),
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, body: data.slice(0, 400) });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: null, body: `REQUEST ERROR: ${err.message}` }));
    req.end();
  });
}

function show(label, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`HTTP ${result.status}`);
  console.log(typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2));
}

// TTLock returns HTTP 200 even for logical failures - the real signal is
// the errcode field. Absence of errcode (or errcode 0) means success.
function verdict(body) {
  if (typeof body !== 'object' || body === null) return 'UNPARSEABLE';
  if (body.errcode === undefined || body.errcode === 0) return 'SUCCESS';
  return `FAILED (errcode ${body.errcode}: ${body.errmsg || 'no message'})`;
}

async function probeLock(unitCode, accessToken, clientId) {
  const device = devices.units.find((u) => u.unit === unitCode);
  if (!device) {
    console.log(`\n########## ${unitCode}: NOT FOUND in devices.json ##########`);
    return;
  }
  if (device.system !== 'ttlock') {
    console.log(`\n########## ${unitCode}: system is "${device.system}", not ttlock - skipping ##########`);
    return;
  }

  const lockId = device.lock_id;
  console.log(`\n\n##################################################`);
  console.log(`# ${unitCode}  (lockId ${lockId})`);
  console.log(`##################################################`);

  const now = () => Date.now().toString();

  // 1. Lock detail - cloud metadata only, does not touch the lock.
  const detail = await apiGet('/v3/lock/detail', { clientId, accessToken, lockId, date: now() });
  show('1. lock/detail (cloud metadata)', detail);
  if (detail.body && typeof detail.body === 'object') {
    console.log(`>> hasGateway flag: ${detail.body.hasGateway} (1 = lock is associated with a gateway)`);
    console.log(`>> modelNum: ${detail.body.modelNum}`);
    console.log(`>> electricQuantity: ${detail.body.electricQuantity}%`);
  }

  // 2. Which gateways does TTLock's cloud think serve this lock?
  //    Endpoint naming varies across TTLock's docs; try both known forms.
  let gwByLock = await apiGet('/v3/gateway/listByLock', { clientId, accessToken, lockId, date: now() });
  if (gwByLock.body && gwByLock.body.errcode !== undefined && gwByLock.body.errcode !== 0) {
    show('2a. gateway/listByLock (first form - failed, trying alternate)', gwByLock);
    gwByLock = await apiGet('/v3/lock/listGateway', { clientId, accessToken, lockId, date: now() });
    show('2b. lock/listGateway (alternate form)', gwByLock);
  } else {
    show('2. gateway/listByLock', gwByLock);
  }

  // 3. THE REAL CONNECTIVITY TEST.
  //    queryDate asks the physical lock what time it holds. A success here
  //    means cloud -> gateway -> lock round-tripped successfully RIGHT NOW.
  //    A -3002 here means the gateway genuinely could not be reached at
  //    this instant, independent of anything the app shows.
  const queryDate = await apiGet('/v3/lock/queryDate', { clientId, accessToken, lockId, date: now() });
  show('3. lock/queryDate  <-- LIVE ROUND-TRIP TEST', queryDate);
  console.log(`>> VERDICT: ${verdict(queryDate.body)}`);
  if (verdict(queryDate.body) === 'SUCCESS') {
    console.log('>> The lock answered through the gateway. The remote path IS working for this lock.');
  }

  // 4. Existing passcodes on this lock - read-only, proves cloud-side
  //    passcode reads work for this lock even if writes are failing.
  const pwdList = await apiGet('/v3/lock/listKeyboardPwd', {
    clientId, accessToken, lockId, pageNo: '1', pageSize: '20', date: now(),
  });
  show('4. lock/listKeyboardPwd (existing passcodes)', pwdList);
  if (pwdList.body && Array.isArray(pwdList.body.list)) {
    console.log(`>> ${pwdList.body.list.length} passcode(s) currently on this lock per the cloud.`);
    console.log('>> If you created one via the app today, it should appear above.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : ['S2103', 'S1503'];

  console.log('TTLock API probe - all checks are READ-ONLY.');
  console.log(`Targets: ${targets.join(', ')}`);
  console.log(`Host: ${HOST}`);

  const accessToken = await ttlock.getAccessToken();
  const clientId = process.env.TTLOCK_CLIENT_ID;
  console.log('Access token obtained OK.');

  // Account-wide gateway list with each gateway's cloud-tracked status.
  const gwList = await apiGet('/v3/gateway/list', {
    clientId, accessToken, pageNo: '1', pageSize: '50', date: Date.now().toString(),
  });
  show('ACCOUNT-WIDE: gateway/list', gwList);
  if (gwList.body && Array.isArray(gwList.body.list)) {
    console.log('\n>> Gateway summary (isOnline: 1 = cloud sees it online, 0 = offline):');
    for (const gw of gwList.body.list) {
      console.log(`   gatewayId ${gw.gatewayId} | ${gw.gatewayName || '(no name)'} | isOnline: ${gw.isOnline} | locks: ${gw.lockNum}`);
    }
  }

  for (const t of targets) {
    await probeLock(t, accessToken, clientId);
  }

  console.log('\n\n=== How to read this ===');
  console.log('Probe 3 (queryDate) is the decisive one: SUCCESS = the full');
  console.log('cloud -> gateway -> lock path is alive for that lock at this moment.');
  console.log('If S2103 SUCCEEDS on probe 3 but passcode creation still fails,');
  console.log('the problem is specific to the passcode call/parameters, NOT connectivity.');
  console.log('If S2103 FAILS on probe 3 while the reference lock SUCCEEDS,');
  console.log('the difference is in how that lock/gateway pair is registered cloud-side.');
}

main().catch((err) => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});

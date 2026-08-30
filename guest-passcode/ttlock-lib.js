/**
 * ttlock-lib.js
 * Reusable functions for TTLock API: auth, lock/key listing, passcode create/delete.
 *
 * Uses Node's built-in https module instead of node-fetch, because node-fetch@2
 * was hitting "Premature close" errors on Windows against TTLock's servers
 * (PowerShell's Invoke-RestMethod worked fine with the identical request,
 * confirming it was a node-fetch/socket-handling issue, not a server problem).
 *
 * TESTED AND CONFIRMED WORKING on 2026-08-04:
 *   - getAccessToken()    ✅ confirmed
 *   - listKeys()          ✅ confirmed (found N-15-03 and S-15-03)
 *   - createTempPasscode() ✅ confirmed (real passcode created + verified on S-15-03)
 *   - deleteTempPasscode() ⚠️ NOT YET TESTED - written but unverified
 *
 * Important finding: a "common user" ekey (userType 110302, NOT admin/110301)
 * was sufficient to create passcodes via API. No need to share admin-level
 * access - regular "Send eKey" sharing from the owner account is enough.
 */

require('dotenv').config();
const https = require('https');

const CLIENT_ID = process.env.TTLOCK_CLIENT_ID;
const CLIENT_SECRET = process.env.TTLOCK_CLIENT_SECRET;
const USERNAME = process.env.TTLOCK_USERNAME;
const PASSWORD_MD5 = process.env.TTLOCK_PASSWORD_MD5;
const HOST = 'euapi.ttlock.com';

/**
 * Low-level request helper using native https, with keep-alive disabled
 * and an explicit Connection: close header - this combination is what
 * fixed the "Premature close" error seen with node-fetch@2 on Windows.
 */
function request(method, path, formBodyObj = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = formBodyObj
      ? new URLSearchParams(formBodyObj).toString()
      : '';

    const options = {
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Connection': 'close', // key fix: avoid keep-alive socket reuse issues
        'User-Agent': 'TuyaTTLockIntegration/1.0',
      },
      agent: new https.Agent({ keepAlive: false }), // key fix: no connection pooling
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Non-JSON response (status ${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** GET requests with query params instead of a body */
function requestGet(path, paramsObj) {
  const query = new URLSearchParams(paramsObj).toString();
  return request('GET', `${path}?${query}`);
}

// ---- Auth ----
async function getAccessToken() {
  const data = await request('POST', '/oauth2/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'password',
    username: USERNAME,
    password: PASSWORD_MD5,
  });
  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ---- List eKeys (shared/received locks - this is what shows YOUR added locks) ----
async function listKeys(accessToken) {
  return requestGet('/v3/key/list', {
    clientId: CLIENT_ID,
    accessToken,
    pageNo: '1',
    pageSize: '20',
    date: Date.now().toString(),
  });
}

/**
 * Create a temporary passcode on a lock.
 * @param {string} accessToken
 * @param {number} lockId - from listKeys() result
 * @param {object} opts
 * @param {string} opts.name - label shown in TTLock app
 * @param {string} opts.passcode - 7-digit plain numeric code
 * @param {number} opts.startTime - unix milliseconds
 * @param {number} opts.endTime - unix milliseconds
 */
async function createTempPasscode(accessToken, lockId, { name, passcode, startTime, endTime }) {
  return request('POST', '/v3/keyboardPwd/add', {
    clientId: CLIENT_ID,
    accessToken,
    lockId: lockId.toString(),
    keyboardPwd: passcode,
    keyboardPwdName: name,
    keyboardPwdType: '3', // 3 = time-limited passcode (matches startDate/endDate usage below)
    startDate: startTime.toString(),
    endDate: endTime.toString(),
    addType: '2', // 2 = set remotely via gateway
    date: Date.now().toString(),
  });
}

/**
 * Delete a temporary passcode from a lock.
 * ⚠️ NOT YET TESTED - verify against a live device before relying on this.
 * @param {number} keyboardPwdId - returned from createTempPasscode's result
 */
async function deleteTempPasscode(accessToken, lockId, keyboardPwdId) {
  return request('POST', '/v3/keyboardPwd/delete', {
    clientId: CLIENT_ID,
    accessToken,
    lockId: lockId.toString(),
    keyboardPwdId: keyboardPwdId.toString(),
    deleteType: '2', // 2 = delete remotely via gateway
    date: Date.now().toString(),
  });
}

module.exports = {
  getAccessToken,
  listKeys,
  createTempPasscode,
  deleteTempPasscode,
};

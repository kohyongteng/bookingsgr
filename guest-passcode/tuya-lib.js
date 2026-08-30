/**
 * tuya-lock-lib.js
 * Reusable functions for reading lock status and setting/removing
 * temporary passcodes on Tuya smart locks via the official SDK.
 *
 * TESTED AND CONFIRMED WORKING on 2026-08-04 against S3001 Lock:
 *   - getLockStatus()      ✅ confirmed
 *   - createTempPassword() ✅ confirmed (real passcode created + verified on physical lock)
 *   - deleteTempPassword() ⚠️ NOT YET TESTED - written but unverified, test before relying on it
 */

// Load .env from THIS file's own folder, not the calling process's cwd.
// Plain `require('dotenv').config()` looks in process.cwd() by default -
// fine when running test-run.js directly from this folder, but wrong once
// the dashboard's server.js (running from C:\Users\scada\bookings-dashboard)
// requires this file - it would silently find no .env and leave
// TUYA_CLIENT_ID/SECRET undefined, causing a cryptic "key ... Received
// undefined" error deep in the AES decryption step below.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const crypto = require('crypto');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const BASE_URL = process.env.TUYA_BASE_URL;

const tuya = new TuyaContext({
  baseUrl: BASE_URL,
  accessKey: CLIENT_ID,
  secretKey: CLIENT_SECRET,
});

/**
 * Decrypts the ticket_key Tuya returns (which is itself encrypted)
 * using your Client Secret as the AES-256-ECB key, PKCS7 padding.
 * Result is a 16-byte key used to encrypt the actual passcode.
 */
function decryptTicketKey(ticketKeyHex) {
  const key = Buffer.from(CLIENT_SECRET, 'utf8'); // must be exactly 32 bytes
  const cipherBytes = Buffer.from(ticketKeyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(true); // Tuya pads with standard PKCS7 - must stay ON
  return Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
}

/**
 * Encrypts the plaintext passcode using the decrypted ticket key.
 * AES-128-ECB, PKCS7 padding, output as uppercase hex.
 */
function encryptPassword(plainPassword, decryptedTicketKeyBuffer) {
  const cipher = crypto.createCipheriv('aes-128-ecb', decryptedTicketKeyBuffer, null);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(plainPassword, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted.toUpperCase();
}

/** Get live status (battery, unlock events, etc.) for any device. Read-only, safe. */
async function getDeviceStatus(deviceId) {
  return tuya.request({ method: 'GET', path: `/v1.0/devices/${deviceId}/status` });
}

/**
 * Creates a temporary passcode on a lock.
 * @param {string} deviceId - Tuya device_id (the "virtual ID") for the lock
 * @param {object} opts
 * @param {string} opts.name - Label shown in the SmartLife app, e.g. "Guest - John Tan"
 * @param {string} opts.password - PLAIN passcode, must be 7 digits per this lock model
 * @param {number} opts.effectiveTime - unix seconds, when the code starts working
 * @param {number} opts.invalidTime - unix seconds, when the code stops working
 * @returns {object} Tuya API response, e.g. { success: true, result: { id: 30016918 } }
 */
async function createTempPassword(deviceId, { name, password, effectiveTime, invalidTime }) {
  const ticketRes = await tuya.request({
    method: 'POST',
    path: `/v1.0/devices/${deviceId}/door-lock/password-ticket`,
  });
  if (!ticketRes.success) {
    throw new Error(`Failed to get password ticket: ${JSON.stringify(ticketRes)}`);
  }

  const { ticket_id, ticket_key } = ticketRes.result;
  const decryptedKey = decryptTicketKey(ticket_key);
  const encryptedPassword = encryptPassword(password, decryptedKey);

  return tuya.request({
    method: 'POST',
    path: `/v1.0/devices/${deviceId}/door-lock/temp-password`,
    body: {
      name,
      password: encryptedPassword,
      password_type: 'ticket',
      ticket_id,
      effective_time: effectiveTime,
      invalid_time: invalidTime,
    },
  });
}

/**
 * Deletes a temporary passcode from a lock by its password_id
 * (the "id" returned from createTempPassword's result).
 * ⚠️ NOT YET TESTED against a live device - verify before relying on this in production.
 */
async function deleteTempPassword(deviceId, passwordId) {
  return tuya.request({
    method: 'DELETE',
    path: `/v1.0/devices/${deviceId}/door-lock/temp-password/${passwordId}`,
  });
}

module.exports = {
  getDeviceStatus,
  createTempPassword,
  deleteTempPassword,
};

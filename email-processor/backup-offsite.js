// backup-offsite.js
//
// Runs backup-full.js, then gets the zip OFF this machine.
//
// Default is EMAIL TO YOURSELF, because it needs no new authorisation: the
// existing token already has gmail.send. Google Drive would have meant a fresh
// OAuth consent in a browser on the mini PC, which is the one thing that
// cannot be automated from here.
//
//   node backup-offsite.js              # zip + email it to the admin address
//   node backup-offsite.js --drive      # zip + upload to Drive instead
//   node backup-offsite.js --no-send    # zip only, deliver nothing
//
// Email trade-offs, stated plainly:
//   - Every run is a NEW message, so old backups accumulate in the mailbox
//     (~4 MB a day). That is also the safety net: a corrupt backup cannot
//     overwrite a good one, which a single replaced file could.
//   - Gmail refuses attachments over 25 MB, so this refuses first rather than
//     failing halfway.
//   - Deleting old backup mails automatically would need a gmail.modify scope
//     this token does not have. Clear them out by hand occasionally.
//
// --drive updates ONE file, so Drive keeps ~30 days of its own revisions.
// It needs a one-off consent:  node authorize.js --account=drive --scopes=drive
//
// >>> The zip contains real credentials and the live guest database. The
//     destination mailbox / Drive must be private and 2FA-protected. <<<

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');
const lib = require('./lib');

const BACKUP_SCRIPT = 'C:\\apps\\backup-full.js';
const BACKUP_DIR = 'C:\\apps\\backups';
const STATE_PATH = path.join(__dirname, 'backup-drive-state.json');
const DRIVE_FILE_NAME = 'swiss-garden-apps-backup.zip';
const BACKUP_EMAIL_TO = process.env.BACKUP_EMAIL_TO || 'teng20240301@gmail.com';

// Gmail's hard limit is 25 MB for an attachment. Base64 inflates by ~33%, so
// the raw zip must stay under roughly 18 MB to survive encoding.
const MAX_EMAIL_ZIP_BYTES = 18 * 1024 * 1024;

const LOCAL_KEEP_DAYS = 7;
// The newest few local zips are ALWAYS kept, whatever their age. Pruning by
// age alone would have deleted the only backup on this machine the first time
// this ran - there was a single zip, 16 days old, when this was written.
const LOCAL_MIN_KEEP = 3;

const useDrive = process.argv.includes('--drive');
const noSend = process.argv.includes('--no-send');
const started = Date.now();
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/** Newest zip in the backup folder - what backup-full.js just produced. */
function newestZip() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const zips = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      return { full, name: f, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return zips[0] || null;
}

function pruneLocalZips() {
  const cutoff = Date.now() - LOCAL_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const zips = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      return { name: f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  for (const z of zips.slice(LOCAL_MIN_KEEP)) {
    if (z.mtime < cutoff) {
      fs.unlinkSync(z.full);
      removed++;
    }
  }
  if (removed) {
    log(`Deleted ${removed} local zip(s) older than ${LOCAL_KEEP_DAYS} days (newest ${LOCAL_MIN_KEEP} always kept).`);
  }
}

async function sendByEmail(zip) {
  if (zip.size > MAX_EMAIL_ZIP_BYTES) {
    throw new Error(
      `Zip is ${(zip.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_EMAIL_ZIP_BYTES / 1024 / 1024} MB email limit ` +
        `(Gmail caps attachments at 25 MB and base64 adds about a third). Switch to --drive, or shrink what is backed up.`
    );
  }

  const gmail = lib.getGmailClient();
  const sizeMB = (zip.size / (1024 * 1024)).toFixed(1);
  const body = [
    `Automatic off-site backup of C:\\apps.`,
    ``,
    `File    : ${zip.name}`,
    `Size    : ${sizeMB} MB`,
    `Made at : ${new Date(zip.mtime).toISOString()}`,
    ``,
    `Contains all project code, the real .env/credential files, and the live`,
    `bookings database. Keep this mailbox private.`,
    ``,
    `To restore: unzip over C:\\apps, then run "npm install" in each project`,
    `folder (node_modules is excluded on purpose, as is .git - the code is on`,
    `GitHub).`,
  ].join('\n');

  await lib.sendEmailWithAttachment(gmail, {
    to: BACKUP_EMAIL_TO,
    subject: `Swiss Garden backup ${zip.name} (${sizeMB} MB)`,
    body,
    filename: zip.name,
    data: fs.readFileSync(zip.full),
  });

  return `emailed to ${BACKUP_EMAIL_TO}`;
}

async function sendByDrive(zip) {
  const auth = lib.getAuthClient('drive');
  const drive = google.drive({ version: 'v3', auth });
  const state = loadState();
  const media = { mimeType: 'application/zip', body: fs.createReadStream(zip.full) };

  // Updating the SAME fileId is what preserves Drive's revision history.
  // Creating a new file daily would lose it and clutter the folder.
  if (state.fileId) {
    try {
      const res = await drive.files.update({
        fileId: state.fileId,
        media,
        requestBody: { name: DRIVE_FILE_NAME },
        fields: 'id,name,size',
      });
      if (Number(res.data.size) !== zip.size) {
        throw new Error(`Drive reports ${res.data.size} bytes, local zip is ${zip.size} - upload incomplete.`);
      }
      return `updated Drive file ${res.data.id}`;
    } catch (err) {
      // The file may have been deleted by hand - create a fresh one rather
      // than failing every night from then on.
      log(`Updating the existing Drive file failed (${err.message}); creating a new one.`);
      delete state.fileId;
      saveState(state);
    }
  }

  const res = await drive.files.create({
    media,
    requestBody: { name: DRIVE_FILE_NAME },
    fields: 'id,name,size',
  });
  if (Number(res.data.size) !== zip.size) {
    throw new Error(`Drive reports ${res.data.size} bytes, local zip is ${zip.size} - upload incomplete.`);
  }
  saveState({ ...loadState(), fileId: res.data.id });
  return `created Drive file ${res.data.id}`;
}

async function main() {
  log('Running backup-full.js ...');
  execFileSync('node', [BACKUP_SCRIPT], { stdio: 'inherit' });

  const zip = newestZip();
  if (!zip) throw new Error(`backup-full.js produced no zip in ${BACKUP_DIR}`);
  log(`Zip ready: ${zip.name} (${(zip.size / 1024 / 1024).toFixed(1)} MB)`);

  // A suspiciously small zip usually means the staging copy failed. Fail loudly
  // rather than deliver a broken backup that looks like a good one.
  if (zip.size < 100 * 1024) {
    throw new Error(`Zip is only ${zip.size} bytes - refusing to send a likely-broken backup.`);
  }

  if (noSend) {
    log('--no-send given; nothing delivered.');
  } else {
    const how = useDrive ? await sendByDrive(zip) : await sendByEmail(zip);
    log(`Delivered: ${how}`);
    saveState({
      ...loadState(),
      lastSuccessAt: new Date().toISOString(),
      lastSizeBytes: zip.size,
      lastMethod: useDrive ? 'drive' : 'email',
    });
  }

  pruneLocalZips();
  log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] BACKUP FAILED:`, err.message);
  // Announced, not merely logged. A backup that silently stops working is
  // worse than no backup, because you believe you are covered.
  try {
    lib.writeOutboxMessage(
      lib.STAFF_GROUP_JID,
      `⚠️ Daily backup FAILED: ${err.message}\n(Nothing was sent. Earlier backups are unaffected.)`
    );
  } catch (notifyErr) {
    console.error('Could not send the failure alert:', notifyErr.message);
  }
  process.exit(1);
});

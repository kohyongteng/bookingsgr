// backup-full.js
//
// ONE script, ONE zip: everything currently live under C:\apps — all six
// project folders' code AND their real .env/credential files, plus the
// shared bookings.db and wa-outbox — staged and compressed into a single
// dated zip for manual download to your Mac.
//
// Excludes:
//   - node_modules  (regenerable via npm install)
//   - .git           (already version-controlled on GitHub separately)
//
// >>> This zip contains REAL credentials (Tuya, TTLock, Gemini, Google
//     OAuth tokens) and the live guest booking database. Treat it as
//     sensitive: download it only via direct scp to your own machine,
//     delete it from Downloads once you've moved it somewhere safe, and
//     never upload it anywhere else (chat, cloud drive, ticket, etc). <<<
//
// Usage (on the mini PC):
//   node C:\apps\backup-full.js
//
// Then from your Mac's terminal:
//   scp scada-remote:C:/apps/backups/<the-zip-name-it-prints> ~/Downloads/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'C:\\apps';
const BACKUP_DIR = path.join(ROOT, 'backups');
const PROJECTS = [
  'bookings-dashboard',
  'email-processor',
  'scraper-service',
  'whatsapp-bot',
  'guest-passcode',
  'tuya-auto',
  'shared-data',
];
const EXCLUDE_DIRS = ['node_modules', '.git'];

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${date}_${time}`;
}

const stamp = timestamp();
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stagingDir = path.join(BACKUP_DIR, `_staging_${stamp}`);
fs.mkdirSync(stagingDir, { recursive: true });

console.log(`Staging full backup at ${stagingDir}\n`);

let copiedAny = false;
for (const proj of PROJECTS) {
  const src = path.join(ROOT, proj);
  if (!fs.existsSync(src)) {
    console.log(`  SKIP (not found): ${proj}`);
    continue;
  }
  const dest = path.join(stagingDir, proj);
  const excludeArgs = EXCLUDE_DIRS.flatMap((d) => ['/XD', d]);
  try {
    execFileSync('robocopy', [src, dest, '/E', ...excludeArgs, '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'inherit' });
  } catch (err) {
    // robocopy's exit code is a bitmask; 0-7 all mean success in some form.
    const code = err.status ?? 0;
    if (code >= 8) {
      console.error(`robocopy failed on ${proj} with exit code ${code}`);
      process.exit(1);
    }
  }
  console.log(`  copied: ${proj}`);
  copiedAny = true;
}

if (!copiedAny) {
  console.error('Nothing found to back up under C:\\apps - aborting.');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  process.exit(1);
}

const zipName = `apps-full_${stamp}.zip`;
const zipPath = path.join(BACKUP_DIR, zipName);

console.log(`\nCompressing to ${zipPath} ...`);
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipPath}' -Force -CompressionLevel Optimal`,
  ],
  { stdio: 'inherit' }
);

fs.rmSync(stagingDir, { recursive: true, force: true });

const sizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`\nDone: ${zipPath} (${sizeMB} MB)`);
console.log('Includes: all project code + real .env/credential files + bookings.db + wa-outbox');
console.log('Excludes: node_modules (regenerable via npm install), .git (already on GitHub)');
console.log('\n>>> Contains real credentials and guest data - handle as sensitive. <<<');
console.log('\nFrom your Mac terminal, download it with:');
console.log(`  scp scada-remote:C:/apps/backups/${zipName} ~/Downloads/`);

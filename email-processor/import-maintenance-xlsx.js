// Imports the SWISS_GARDEN workbook (already unzipped) into maintenance_records
// and room_inventory.
//
// Dating rule, as specified by the owner: within each sheet the TOP dated row
// is the most recent, so years are walked backwards down the sheet - the year
// decrements whenever the next date would otherwise be in the future relative
// to the row above it. Anything that lands more than 12 months back is IGNORED.
// The sheets carry no years at all, so this is the only stated rule; entries
// older than a year are deliberately dropped rather than guessed at.
//
// Everything imported is marked status 'done' (historical log) with the original
// spreadsheet line kept in notes for traceability.
//
// Usage:
//   node import-maintenance-xlsx.js                 dry run (default)
//   node import-maintenance-xlsx.js --apply
//   node import-maintenance-xlsx.js --apply --skip-logs=S2103 --skip-overview=S2103

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// The workbook must be unzipped first (an .xlsx is a zip of XML, and this
// script deliberately has no parsing dependency):
//   Copy-Item SWISS_GARDEN.xlsx swiss.zip
//   Expand-Archive swiss.zip -DestinationPath C:\apps\xlsx_extract
// Point --extract= at that folder (it must contain xl\workbook.xml).
const EXTRACT =
  (process.argv.slice(2).find((a) => a.startsWith('--extract=')) || '').split('=')[1] ||
  'C:/apps/xlsx_extract';
const SOURCE = 'SWISS_GARDEN.xlsx';

if (!fs.existsSync(path.join(EXTRACT, 'xl/workbook.xml'))) {
  console.error(`No workbook found at ${EXTRACT}\\xl\\workbook.xml - unzip the .xlsx first and pass --extract=<folder> (see the header comment).`);
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const listArg = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1].split(',').filter(Boolean) : [];
};
const SKIP_LOGS = listArg('skip-logs');
const SKIP_OVERVIEW = listArg('skip-overview');

// ---------- xlsx reading (no dependency; the file is a zip of XML) ----------
const read = (p) => fs.readFileSync(path.join(EXTRACT, p), 'utf8');
const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&amp;/g, '&');

const sharedStrings = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
  [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join('')
);
const rels = {};
for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
  rels[m[1]] = m[2].replace(/^\/xl\//, '').replace(/^(?!xl\/)/, 'xl/');
}
const sheets = [...read('xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
  .map((m) => ({ name: decode(m[1]), file: rels[m[2]] }));

function sheetTexts(file) {
  const xml = read(file);
  const out = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    for (const cm of rm[2].matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      if (!/t="s"/.test(cm[0])) continue;
      const v = /<v>([\s\S]*?)<\/v>/.exec(cm[0])?.[1];
      if (v === undefined) continue;
      const text = (sharedStrings[Number(v)] || '').trim();
      if (text) out.push({ row: Number(rm[1]), text });
    }
  }
  return out;
}

// ---------- classification ----------
const DATE_RE = /^(\d{1,2})\s*[\/.]\s*(\d{1,2})\b\s*(.*)$/s;
const isOverview = (t) => /\s-\s|^[A-Za-z][\w ]{0,18}-/.test(t);

// ---------- the dating rule ----------
const isoLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function assignDates(entries, today) {
  // entries are in sheet order (top = newest). Walk down, never moving forward
  // in time: if a row's month/day would land after the row above it, it must
  // belong to the previous year.
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const out = [];
  for (const e of entries) {
    let year = cursor.getFullYear();
    let d = new Date(year, e.month - 1, e.day);
    while (d > cursor) {
      year -= 1;
      d = new Date(year, e.month - 1, e.day);
    }
    out.push({ ...e, date: d, iso: isoLocal(d) });
    cursor = d;
  }
  return out;
}

// ---------- build ----------
const today = new Date();
const cutoff = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());

const logRows = [];
const invRows = [];
const dropped = [];
const unclassified = [];
const perSheet = [];

for (const s of sheets) {
  const texts = sheetTexts(s.file).filter((t) => t.text !== s.name);
  const dated = [];
  let overviewCount = 0;

  for (const t of texts) {
    const m = DATE_RE.exec(t.text);
    if (m) {
      dated.push({ room: s.name, month: Number(m[1]), day: Number(m[2]), desc: m[3].trim(), raw: t.text, row: t.row });
    } else if (isOverview(t.text)) {
      const idx = t.text.indexOf('-');
      const item = t.text.slice(0, idx).trim();
      const detail = t.text.slice(idx + 1).trim();
      if (!SKIP_OVERVIEW.includes(s.name)) invRows.push({ room: s.name, item, detail: detail || null });
      overviewCount++;
    } else {
      unclassified.push(`${s.name} r${t.row}: ${t.text}`);
    }
  }

  const withDates = assignDates(dated, today);
  let kept = 0;
  for (const e of withDates) {
    if (e.date < cutoff) { dropped.push(e); continue; }
    if (SKIP_LOGS.includes(s.name)) { continue; }
    logRows.push(e);
    kept++;
  }
  perSheet.push({
    room: s.name,
    dated: dated.length,
    kept: SKIP_LOGS.includes(s.name) ? 0 : kept,
    skipped: SKIP_LOGS.includes(s.name) ? withDates.filter((e) => e.date >= cutoff).length : 0,
    tooOld: withDates.filter((e) => e.date < cutoff).length,
    overview: SKIP_OVERVIEW.includes(s.name) ? 0 : overviewCount,
  });
}

// ---------- report ----------
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} - dating rule: top row newest, years walked backwards, ignore older than ${isoLocal(cutoff)}`);
if (SKIP_LOGS.length) console.log(`skipping maintenance rows for: ${SKIP_LOGS.join(', ')}`);
if (SKIP_OVERVIEW.length) console.log(`skipping overview rows for: ${SKIP_OVERVIEW.join(', ')}`);

console.log('\nroom    dated  import  skipped  >1yr  overview');
for (const p of perSheet) {
  console.log(
    `  ${p.room.padEnd(6)} ${String(p.dated).padStart(4)} ${String(p.kept).padStart(6)} ` +
    `${String(p.skipped).padStart(8)} ${String(p.tooOld).padStart(5)} ${String(p.overview).padStart(8)}`
  );
}
console.log(`\ntotals: ${logRows.length} maintenance rows, ${invRows.length} inventory rows, ` +
            `${dropped.length} dropped as older than 1 year, ${unclassified.length} unclassified`);

if (logRows.length) {
  const dates = logRows.map((r) => r.iso).sort();
  console.log(`date range to import: ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log('\nsample (newest 5):');
  for (const r of [...logRows].sort((a, b) => b.iso.localeCompare(a.iso)).slice(0, 5)) {
    console.log(`  ${r.iso}  ${r.room.padEnd(6)} ${r.desc.slice(0, 70)}`);
  }
}

// Lines that read as still-outstanding, so they can be reopened deliberately
// rather than everything being silently marked done.
const OPEN_HINT = /needed|not work|not hot|spoil|broke|broken|problem|pending/i;
const looksOpen = logRows.filter((r) => OPEN_HINT.test(r.desc));
if (looksOpen.length) {
  console.log(`\n${looksOpen.length} imported line(s) read as possibly still outstanding (imported as 'done'):`);
  for (const r of looksOpen) console.log(`  ${r.iso}  ${r.room.padEnd(6)} ${r.desc.slice(0, 70)}`);
}
if (unclassified.length) {
  console.log('\nunclassified (not imported):');
  for (const u of unclassified) console.log('  ' + u);
}

// ---------- write ----------
if (!APPLY) {
  console.log('\n(dry run - nothing written. Re-run with --apply.)');
  process.exit(0);
}

const db = lib.openDb();
const insertLog = db.prepare(`
  INSERT INTO maintenance_records
    (room_number, event_date, category, description, status, notes, created_by, created_at, updated_at)
  VALUES (?, ?, NULL, ?, 'done', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`);
const existsLog = db.prepare(
  'SELECT 1 FROM maintenance_records WHERE room_number = ? AND event_date = ? AND description = ?'
);
const upsertInv = db.prepare(`
  INSERT INTO room_inventory (room_number, item, detail, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(room_number, item) DO UPDATE SET
    detail = excluded.detail, source = excluded.source, updated_at = CURRENT_TIMESTAMP
`);

let insertedLogs = 0, duplicateLogs = 0, invWritten = 0;
db.transaction(() => {
  for (const r of logRows) {
    if (existsLog.get(r.room, r.iso, r.desc)) { duplicateLogs++; continue; }
    insertLog.run(r.room, r.iso, r.desc, `imported from ${SOURCE}: "${r.raw}"`, `import:${SOURCE}`);
    insertedLogs++;
  }
  for (const i of invRows) {
    upsertInv.run(i.room, i.item, i.detail, SOURCE);
    invWritten++;
  }
})();

console.log(`\nwritten: ${insertedLogs} maintenance rows (${duplicateLogs} already present, skipped), ${invWritten} inventory rows`);
console.log('maintenance_records total:', db.prepare('SELECT COUNT(*) c FROM maintenance_records').get().c);
console.log('room_inventory total     :', db.prepare('SELECT COUNT(*) c FROM room_inventory').get().c);
db.close();

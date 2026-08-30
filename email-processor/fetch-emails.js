const fs = require('fs');
const lib = require('./lib');

const OUTPUT_PATH = './pending_bookings.json';

function getMonthsArg() {
  const arg = process.argv.find((a) => a.startsWith('--months='));
  if (!arg) return 24;
  const n = parseInt(arg.split('=')[1], 10);
  return isNaN(n) ? 24 : n;
}

function getSinceArg() {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  if (!arg) return null;
  const dateStr = arg.split('=')[1];
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const months = getMonthsArg();
  const cutoffDate = getSinceArg();
  const gmail = lib.getGmailClient();

  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const afterDate = lib.formatGmailDate(d);

  const query = `from:booking.com subject:"booking" after:${afterDate}`;
  console.log(`[${new Date().toISOString()}] Querying Gmail: ${query}`);
  console.log(`Check-in cutoff: ${cutoffDate ? cutoffDate.toDateString() : 'today (default)'}\n`);

  const messages = await lib.listAllMessages(gmail, query);
  console.log(`Found ${messages.length} matching emails.\n`);

  console.log('Step 1: reading subject lines to identify every relevant booking...');
  const candidates = [];
  let checked = 0;
  for (const m of messages) {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });
    const candidate = lib.parseSubjectOnly(meta.data, cutoffDate);
    if (candidate) candidates.push({ id: m.id, ...candidate });
    checked++;
    if (checked % 200 === 0) {
      console.log(`  ...checked ${checked} / ${messages.length} subjects`);
    }
  }

  const dedupedCandidates = lib.dedupe(candidates);

  console.log(`\n=== GROUND TRUTH ===`);
  console.log(`Total distinct bookings identified from subject lines: ${dedupedCandidates.length}`);
  const byType = {};
  dedupedCandidates.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
  console.log('Breakdown by type:', byType);
  console.log('');

  console.log('Step 2: building booking links and fetching guest names for cancellations...');
  const results = [];
  let processed = 0;

  for (const candidate of dedupedCandidates) {
    if (candidate.type === 'CANCELLED') {
      // Only cancellations need the full body (to get the guest name).
      const full = await gmail.users.messages.get({ userId: 'me', id: candidate.id, format: 'full' });
      const parsed = lib.parseBody(candidate, full.data);
      results.push(parsed);
    } else {
      // NEW/MODIFIED: no body fetch needed at all - link is built directly.
      const parsed = lib.parseBody(candidate, null);
      results.push(parsed);
    }

    processed++;
    if (processed % 50 === 0) {
      console.log(`  ...processed ${processed} / ${dedupedCandidates.length}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  console.log(`\n=== FINAL SUMMARY ===`);
  console.log(`Total bookings written to ${OUTPUT_PATH}: ${results.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

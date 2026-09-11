// pm2 watchdog - run every 15 minutes by the PM2Watchdog scheduled task
// (via C:\Users\scada\pm2-watchdog.ps1). Checks the pm2 daemon and every app
// saved in dump.pm2, and repairs only what is actually broken:
//
//   daemon unreachable / app missing  -> pm2 resurrect
//   app "errored" (crash loop, pm2 gave up auto-restarting) -> pm2 restart <app>
//   app "stopped"                     -> left alone
//
// "stopped" must be left alone: the dashboard's WhatsApp on/off toggle does
// `pm2 stop whatsapp-bot-v2`, and restarting it would silently override that.
//
// `pm2 resurrect` is safe to call with apps already running - pm2 only starts
// apps whose name is absent from the live list (lib/API/Startup.js).
//
// Usage:
//   node pm2-watchdog.js              check and repair
//   node pm2-watchdog.js --dry-run    report what it would do, change nothing
//   node pm2-watchdog.js --expect=a,b check these app names instead of dump.pm2 (testing)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PM2 = 'C:\\Users\\scada\\AppData\\Roaming\\npm\\pm2.cmd';
const DUMP = 'C:\\Users\\scada\\.pm2\\dump.pm2';
const LOG = path.join(__dirname, 'pm2-watchdog.log');
const LOCK = path.join(__dirname, 'pm2-watchdog.lock');
const LOG_MAX_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 5 * 60 * 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const expectArg = args.find((a) => a.startsWith('--expect='));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${DRY_RUN ? '(dry-run) ' : ''}${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG, LOG + '.old');
    }
    fs.appendFileSync(LOG, line + '\n');
  } catch (err) {
    console.error('could not write log:', err.message);
  }
}

function pm2(...pm2Args) {
  // .cmd files need a shell on Windows. Passed as one command string: Node
  // warns (DEP0190) when an args array is combined with shell:true, which
  // would clutter the log on every run. App names come from pm2's own list or
  // dump.pm2 and are checked to be plain names, so nothing needs escaping.
  for (const a of pm2Args) {
    if (!/^[\w.-]+$/.test(a)) throw new Error(`refusing unsafe pm2 argument: ${a}`);
  }
  const r = spawnSync(`"${PM2}" ${pm2Args.join(' ')}`, { shell: true, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function readLiveList() {
  const r = pm2('jlist');
  // An elevated daemon rejects a normal user with EPERM. resurrect can't fix
  // that - it would only spawn a stray daemon beside the elevated one.
  if (/EPERM/.test(r.out)) return { eperm: true };
  const start = r.out.indexOf('[');
  if (start === -1) return { error: r.out.trim().slice(0, 300) || `exit code ${r.status}` };
  try {
    // JSON.parse tolerates the duplicate username/USERNAME env keys that make
    // PowerShell's ConvertFrom-Json reject this output.
    return { list: JSON.parse(r.out.slice(start)) };
  } catch (err) {
    return { error: `unparseable pm2 jlist output: ${err.message}` };
  }
}

function expectedApps() {
  if (expectArg) return expectArg.split('=')[1].split(',').filter(Boolean);
  const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  return dump.map((a) => a.name);
}

function acquireLock() {
  // The logon startup task also runs pm2 resurrect; don't let two repairs race
  // and spawn duplicate daemons.
  try {
    if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < LOCK_STALE_MS) return false;
    fs.writeFileSync(LOCK, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!DRY_RUN && !acquireLock()) {
    log('another watchdog run is in progress - skipping');
    return 0;
  }

  try {
    const expected = expectedApps();
    let live = readLiveList();

    if (live.eperm) {
      log('ERROR: pm2 daemon unreachable (EPERM) - it is running as administrator. ' +
          'Not resurrecting, which would only spawn a stray daemon. Fix the elevation, then pm2 resurrect.');
      return 1;
    }
    if (live.error) {
      log(`pm2 not responding (${live.error}) - running pm2 resurrect`);
      if (!DRY_RUN) {
        pm2('resurrect');
        live = readLiveList();
        if (!live.list) {
          log('ERROR: pm2 still not responding after resurrect');
          return 1;
        }
      } else {
        return 0;
      }
    }

    const byName = new Map(live.list.map((p) => [p.name, p]));
    const missing = expected.filter((name) => !byName.has(name));
    const errored = expected.filter((name) => byName.get(name)?.pm2_env?.status === 'errored');
    const stopped = expected.filter((name) => byName.get(name)?.pm2_env?.status === 'stopped');

    if (missing.length) {
      log(`missing from pm2: ${missing.join(', ')} - running pm2 resurrect`);
      if (!DRY_RUN) pm2('resurrect');
    }
    for (const name of errored) {
      log(`${name} is errored - restarting`);
      if (!DRY_RUN) {
        const r = pm2('restart', name);
        if (r.status !== 0) log(`ERROR: restart ${name} failed: ${r.out.trim().slice(0, 300)}`);
      }
    }
    if (stopped.length) {
      log(`stopped (left alone, assumed intentional): ${stopped.join(', ')}`);
    }

    if (!DRY_RUN && (missing.length || errored.length)) {
      const after = readLiveList();
      if (after.list) {
        const summary = expected
          .map((n) => `${n}=${after.list.find((p) => p.name === n)?.pm2_env?.status || 'MISSING'}`)
          .join(', ');
        log(`after repair: ${summary}`);
      }
    } else if (!missing.length && !errored.length && !stopped.length) {
      log(`ok - all ${expected.length} apps online`);
    }
    return 0;
  } catch (err) {
    log(`ERROR: watchdog failed: ${err.stack || err.message}`);
    return 1;
  } finally {
    if (!DRY_RUN) {
      try { fs.unlinkSync(LOCK); } catch {}
    }
  }
}

process.exitCode = main();

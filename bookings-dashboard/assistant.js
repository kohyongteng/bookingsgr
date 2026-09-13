// AI Assistant - turns a typed instruction ("record S2005 today bedroom AC
// leaking") into a database change, without letting the model write anything.
//
// SAFETY MODEL, which is the whole point of this file:
//   * Claude can READ freely (bookings, maintenance, room inventory).
//   * Claude can NEVER write. The write tools are named propose_* and only
//     register an intention; they touch no tables.
//   * A proposal is executed by plain deterministic code in this file, and only
//     after the user replies "Proceed". Every value is re-validated at that
//     point - room against the real room list, dates against a strict format -
//     so a misread instruction cannot reach the database.
//   * Booking dates and room assignment are deliberately NOT exposed: they feed
//     availability, room assignment and the calendar, where a wrong edit can
//     double-book a unit. Only booking NOTES can be changed.
//
// Model choice follows the project default (claude-opus-5). A manual tool loop
// is used rather than the SDK's beta tool-runner helper: the approval gate has
// to sit between "Claude decided" and "the database changed", and this keeps
// that boundary explicit and free of a beta dependency.

const Database = require('better-sqlite3');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5';
const MAX_TOOL_ITERATIONS = 8;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CONFIRM_LINE = 'reply "Proceed" to confirm';

let anthropic = null;
function client() {
  if (!anthropic) {
    // Constructed lazily so a missing key surfaces as a clean API error at
    // request time rather than crashing the whole dashboard at startup.
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) {
      const err = new Error('ANTHROPIC_API_KEY is not set for the dashboard process');
      err.userFacing = true;
      throw err;
    }
    anthropic = new Anthropic();
  }
  return anthropic;
}

// Pending proposals, keyed by session id: one live proposal per user at a time.
const pending = new Map();

function setPending(sessionId, proposal) {
  pending.set(sessionId, { ...proposal, createdAt: Date.now() });
}
function getPending(sessionId) {
  const p = pending.get(sessionId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
    pending.delete(sessionId);
    return null;
  }
  return p;
}
function clearPending(sessionId) {
  pending.delete(sessionId);
}

const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- tool schemas
// strict:true + additionalProperties:false so tool arguments always validate -
// a hallucinated extra field fails loudly instead of being silently ignored.
function toolDefs(rooms) {
  const roomProp = { type: 'string', enum: rooms, description: 'Physical unit number' };
  const strict = (name, description, properties, required) => ({
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  });

  return [
    strict('list_rooms', 'List every physical unit number.', {}, []),
    strict(
      'find_bookings',
      'Find bookings. Use to resolve which reservation a guest instruction refers to, e.g. the booking checking out of N3001 tomorrow.',
      {
        room: { ...roomProp, description: 'Assigned unit to filter by' },
        check_out: { type: 'string', description: 'Exact check-out date, YYYY-MM-DD' },
        check_in: { type: 'string', description: 'Exact check-in date, YYYY-MM-DD' },
        staying_on: { type: 'string', description: 'Date the stay covers (check_in <= date < check_out), YYYY-MM-DD' },
        guest_name: { type: 'string', description: 'Partial guest name, case-insensitive' },
      },
      []
    ),
    strict(
      'list_maintenance',
      'List maintenance records, newest first.',
      {
        room: roomProp,
        from: { type: 'string', description: 'Earliest event date, YYYY-MM-DD' },
        to: { type: 'string', description: 'Latest event date, YYYY-MM-DD' },
        status: { type: 'string', enum: ['open', 'done'] },
      },
      []
    ),
    strict('get_room_inventory', 'Appliance and room facts for one unit (AC brand, washer, TV, view).', { room: roomProp }, ['room']),
    strict(
      'propose_add_maintenance',
      'Propose adding a maintenance record. Does NOT save it - the user must confirm.',
      {
        room: roomProp,
        event_date: { type: 'string', description: 'Date of the event, YYYY-MM-DD' },
        description: { type: 'string', description: 'What happened, in the words of the instruction' },
        category: { type: 'string', enum: ['Aircon', 'Plumbing', 'Electrical', 'Furniture', 'Appliance', 'Door / Lock', 'Cleaning', 'Other'] },
        notes: { type: 'string', description: 'Extra detail such as cost or vendor' },
        status: { type: 'string', enum: ['open', 'done'], description: 'open if it still needs work, done if already fixed' },
      },
      ['room', 'event_date', 'description']
    ),
    strict(
      'propose_set_maintenance_status',
      'Propose marking an existing maintenance record done, or reopening it. Does NOT save it.',
      {
        record_id: { type: 'integer', description: 'id from list_maintenance' },
        status: { type: 'string', enum: ['open', 'done'] },
      },
      ['record_id', 'status']
    ),
    strict(
      'propose_set_booking_note',
      'Propose adding a note to a booking, e.g. an agreed late check-out time. Does NOT save it, and cannot change dates, rooms or status.',
      {
        booking_number: { type: 'string', description: 'booking_number from find_bookings' },
        note: { type: 'string', description: 'The note text to record' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append keeps any existing note (default)' },
      },
      ['booking_number', 'note']
    ),
  ];
}

// ------------------------------------------------------------- read-only tools
function runReadTool(ctx, name, input) {
  const db = new Database(ctx.dbPath, { readonly: true });
  try {
    if (name === 'list_rooms') return { rooms: ctx.rooms };

    if (name === 'find_bookings') {
      const where = ["status != 'cancelled'"];
      const params = [];
      if (input.room) { where.push('assigned_room = ?'); params.push(input.room); }
      if (input.check_out) { where.push('check_out = ?'); params.push(input.check_out); }
      if (input.check_in) { where.push('check_in = ?'); params.push(input.check_in); }
      if (input.staying_on) { where.push('check_in <= ? AND check_out > ?'); params.push(input.staying_on, input.staying_on); }
      if (input.guest_name) { where.push('LOWER(guest_name) LIKE ?'); params.push(`%${String(input.guest_name).toLowerCase()}%`); }
      const rows = db.prepare(`
        SELECT booking_number, platform, guest_name, check_in, check_out, assigned_room, status, notes
        FROM bookings WHERE ${where.join(' AND ')}
        ORDER BY check_out DESC LIMIT 20
      `).all(...params);
      return { count: rows.length, bookings: rows };
    }

    if (name === 'list_maintenance') {
      const where = [];
      const params = [];
      if (input.room) { where.push('room_number = ?'); params.push(input.room); }
      if (input.from) { where.push('event_date >= ?'); params.push(input.from); }
      if (input.to) { where.push('event_date <= ?'); params.push(input.to); }
      if (input.status) { where.push('status = ?'); params.push(input.status); }
      const rows = db.prepare(`
        SELECT id, room_number, event_date, category, description, status, notes
        FROM maintenance_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY event_date DESC, id DESC LIMIT 40
      `).all(...params);
      return { count: rows.length, records: rows };
    }

    if (name === 'get_room_inventory') {
      const rows = db.prepare('SELECT item, detail FROM room_inventory WHERE room_number = ? ORDER BY item').all(input.room);
      return { room: input.room, items: rows };
    }

    return { error: `unknown tool ${name}` };
  } finally {
    db.close();
  }
}

// -------------------------------------------------------------- proposal build
// Validation happens HERE as well as at execution time, so Claude gets a clear
// error it can correct in-conversation instead of the user discovering it after
// tapping Proceed.
function buildProposal(ctx, name, input) {
  if (name === 'propose_add_maintenance') {
    if (!ctx.rooms.includes(input.room)) return { error: `Unknown unit "${input.room}"` };
    if (!isoDate(input.event_date)) return { error: 'event_date must be YYYY-MM-DD' };
    if (!String(input.description || '').trim()) return { error: 'description is required' };
    const status = input.status === 'open' ? 'open' : 'done';
    return {
      proposal: {
        action: 'add_maintenance',
        args: {
          room: input.room,
          event_date: input.event_date,
          description: String(input.description).trim(),
          category: input.category || null,
          notes: input.notes ? String(input.notes).trim() : null,
          status,
        },
        summary:
          `Add maintenance record - ${input.room} on ${input.event_date}: ` +
          `"${String(input.description).trim()}"` +
          `${input.category ? ` [${input.category}]` : ''} (${status})`,
      },
    };
  }

  if (name === 'propose_set_maintenance_status') {
    const db = new Database(ctx.dbPath, { readonly: true });
    try {
      const rec = db.prepare('SELECT id, room_number, event_date, description, status FROM maintenance_records WHERE id = ?').get(input.record_id);
      if (!rec) return { error: `No maintenance record with id ${input.record_id}` };
      if (!['open', 'done'].includes(input.status)) return { error: 'status must be open or done' };
      return {
        proposal: {
          action: 'set_maintenance_status',
          args: { record_id: rec.id, status: input.status },
          summary: `Mark ${input.status} - record #${rec.id} (${rec.room_number} ${rec.event_date}: "${rec.description}"), currently ${rec.status}`,
        },
      };
    } finally {
      db.close();
    }
  }

  if (name === 'propose_set_booking_note') {
    const db = new Database(ctx.dbPath, { readonly: true });
    try {
      const b = db.prepare('SELECT booking_number, guest_name, assigned_room, check_in, check_out, notes FROM bookings WHERE booking_number = ?').get(String(input.booking_number));
      if (!b) return { error: `No booking ${input.booking_number}` };
      if (!String(input.note || '').trim()) return { error: 'note is required' };
      const mode = input.mode === 'replace' ? 'replace' : 'append';
      return {
        proposal: {
          action: 'set_booking_note',
          args: { booking_number: b.booking_number, note: String(input.note).trim(), mode },
          summary:
            `${mode === 'replace' ? 'Replace' : 'Add'} note on booking ${b.booking_number} ` +
            `(${b.guest_name || 'guest'}, ${b.assigned_room || 'unassigned'}, ${b.check_in} to ${b.check_out}): ` +
            `"${String(input.note).trim()}"` +
            (mode === 'append' && b.notes ? `\nExisting note kept: "${b.notes}"` : ''),
        },
      };
    } finally {
      db.close();
    }
  }

  return { error: `unknown tool ${name}` };
}

// ------------------------------------------------------------------- execution
function executeProposal(ctx, proposal, username) {
  const db = new Database(ctx.dbPath);
  try {
    const { action, args } = proposal;

    if (action === 'add_maintenance') {
      // Re-validated at execution: the room list or the record could have
      // changed between proposing and confirming.
      if (!ctx.rooms.includes(args.room)) throw new Error(`Unknown unit "${args.room}"`);
      if (!isoDate(args.event_date)) throw new Error('event_date must be YYYY-MM-DD');
      const info = db.prepare(`
        INSERT INTO maintenance_records
          (room_number, event_date, category, description, status, notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(args.room, args.event_date, args.category, args.description, args.status, args.notes, `ai:${username}`);
      return `Saved. Maintenance record #${info.lastInsertRowid} for ${args.room} on ${args.event_date}.`;
    }

    if (action === 'set_maintenance_status') {
      const info = db.prepare('UPDATE maintenance_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(args.status, args.record_id);
      if (!info.changes) throw new Error(`Record #${args.record_id} no longer exists`);
      return `Saved. Record #${args.record_id} is now ${args.status}.`;
    }

    if (action === 'set_booking_note') {
      const b = db.prepare('SELECT notes FROM bookings WHERE booking_number = ?').get(args.booking_number);
      if (!b) throw new Error(`Booking ${args.booking_number} no longer exists`);
      const next =
        args.mode === 'replace' || !b.notes
          ? args.note
          : `${b.notes}\n${args.note}`;
      db.prepare('UPDATE bookings SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE booking_number = ?')
        .run(next, args.booking_number);
      return `Saved. Note recorded on booking ${args.booking_number}.`;
    }

    throw new Error(`Unknown action ${action}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- system prompt
function systemPrompt(rooms) {
  return `You are the operations assistant for Swiss Garden Residences by The Boston House, a short-stay apartment operation in Bukit Bintang, Kuala Lumpur. You help staff record things in the operations database by typing plain instructions.

Today's date is ${todayISO()}. Interpret "today", "tomorrow" and "yesterday" against it, and always convert to YYYY-MM-DD.

The physical units are: ${rooms.join(', ')}.

You CANNOT change the database yourself. For any change you must call a propose_* tool, which only registers the intention - the staff member then confirms it. Never say something has been recorded, saved or done; say what you are about to do and that it needs confirming.

Rules:
- Read first when the instruction refers to a booking ("N3001 checks out tomorrow at 2pm"): use find_bookings to identify the exact reservation before proposing a note. If more than one booking matches, ask which one instead of guessing.
- An agreed late check-out time is recorded as a booking NOTE. You cannot change check-in/check-out dates or room assignment - if asked, say so plainly and offer to record it as a note.
- Maintenance: if the instruction describes something that happened and is already handled, propose status "done"; if it still needs attention, propose "open".
- Use the unit number exactly as listed. If the instruction names a unit you do not recognise, say so and list the closest matches.
- Keep the description in the staff member's own words - do not embellish.
- Be brief. One or two short sentences, then the proposal.
- Answer read-only questions directly, with no proposal.
- CRITICAL: you may only describe a change as pending if you have actually called the matching propose_* tool in the same turn. Writing out a change in prose and asking for confirmation, without that tool call, leaves the user confirming something that does not exist - the Proceed button is wired to the tool, not to your words. If a propose_* tool returns an error, report that error instead of describing the change as pending.`;
}

// --------------------------------------------------------------- main entry
/**
 * Handle one typed message. Returns { reply, pendingSummary|null, executed|null }.
 * "Proceed" is handled entirely here - no model call - so a confirmation can
 * never be re-interpreted into a different action.
 */
async function handleMessage(ctx, { sessionId, username, message, history = [], onProgress }) {
  const text = String(message || '').trim();
  if (!text) return { reply: 'Say what you would like me to do.', pendingSummary: null };

  if (/^proceed[\s!.]*$/i.test(text)) {
    const p = getPending(sessionId);
    if (!p) {
      return { reply: 'There is nothing waiting to be confirmed. Tell me what to record and I will propose it first.', pendingSummary: null };
    }
    clearPending(sessionId);
    try {
      const result = executeProposal(ctx, p, username);
      return { reply: result, pendingSummary: null, executed: p.summary };
    } catch (err) {
      return { reply: `Could not save that: ${err.message}`, pendingSummary: null };
    }
  }

  if (/^cancel[\s!.]*$/i.test(text)) {
    const had = !!getPending(sessionId);
    clearPending(sessionId);
    return { reply: had ? 'Cancelled - nothing was saved.' : 'Nothing was pending.', pendingSummary: null };
  }

  const tools = toolDefs(ctx.rooms);
  const messages = [
    ...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  let proposal = null;
  // Every tool call and its result, accumulated across iterations and handed
  // out through onProgress. Deliberately NOT part of the returned result:
  // getJob spreads that straight to the browser on every poll, and this trail
  // is for the audit log, not the phone.
  const toolTrail = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      // Routing a short instruction to one tool does not need deep reasoning,
      // and every second here is a second the phone waits. 'medium' rather
      // than 'low': at low effort the model was the thing that previously
      // described a change without calling the propose_* tool.
      output_config: { effort: 'medium' },
      system: systemPrompt(ctx.rooms),
      tools,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return { reply: 'I could not process that request.', pendingSummary: null };
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
      let reply = textBlocks.join('\n\n') || 'Done.';
      if (proposal) {
        setPending(sessionId, proposal);
        // Enforced rather than trusted: the confirm line must always be there,
        // otherwise a proposal could sit pending with the user unaware.
        if (!reply.toLowerCase().includes('proceed')) {
          reply = `${reply}\n\n${proposal.summary}\n\n${CONFIRM_LINE}`;
        } else if (!reply.includes(proposal.summary)) {
          reply = `${reply}\n\n${proposal.summary}`;
        }
      } else if (/\bproceed\b|\bconfirm/i.test(reply)) {
        // Claude described a change in prose without calling a propose_* tool,
        // so nothing is registered. Observed in testing: the user is invited to
        // confirm, taps Proceed, and nothing happens. Say so plainly rather
        // than letting the reply imply something is waiting.
        console.warn(`[assistant] ${username} asked for confirmation with NO proposal registered - reply corrected`);
        reply =
          `${reply}\n\n---\nI did not actually register that change, so there is nothing to confirm yet. ` +
          `Please send the instruction again - for example "record S2005 today bedroom AC leaking" or ` +
          `"add note to booking HMAJYMEZEF: late check-out 2pm".`;
      }
      return { reply, pendingSummary: proposal ? proposal.summary : null };
    }

    messages.push({ role: 'assistant', content: response.content });
    // Logged so "why did the assistant do that?" is answerable from the pm2
    // log - without this there is no record of which tools ran.
    console.log(
      `[assistant] ${username} iter${i + 1} tools: ` +
      toolUses.map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 160)})`).join(' ')
    );
    // Reported so the page can show "3 queries" rather than a blank wait.
    if (onProgress) onProgress({ queries: i + 1, tools: toolUses.map((t) => t.name) });
    const results = [];
    for (const tu of toolUses) {
      let content;
      try {
        if (tu.name.startsWith('propose_')) {
          const built = buildProposal(ctx, tu.name, tu.input || {});
          if (built.error) {
            content = JSON.stringify({ error: built.error });
          } else {
            proposal = built.proposal;
            content = JSON.stringify({
              registered: true,
              summary: proposal.summary,
              note: 'Nothing is saved yet. Tell the user what will happen and that it needs confirming.',
            });
          }
        } else {
          content = JSON.stringify(runReadTool(ctx, tu.name, tu.input || {}));
        }
      } catch (err) {
        content = JSON.stringify({ error: err.message });
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
      // Result truncated on purpose: a read tool can return a long list of
      // bookings, and the point of the trail is which tool ran with which
      // arguments - not a second copy of the data already in the database.
      toolTrail.push({
        iter: i + 1,
        name: tu.name,
        input: tu.input || {},
        result: typeof content === 'string' ? content.slice(0, 500) : null,
      });
    }
    messages.push({ role: 'user', content: results });
    // Reported a second time now the results are known: the call above fires
    // before the tools actually run, so it cannot carry them.
    if (onProgress) {
      onProgress({ queries: i + 1, tools: toolUses.map((t) => t.name), trail: toolTrail });
    }
  }

  return {
    reply: 'That needed too many steps - please try phrasing it more directly, e.g. "record S2005 today bedroom AC leaking".',
    pendingSummary: null,
  };
}

// ------------------------------------------------------------------- jobs
// Why jobs instead of just answering on the POST: the old endpoint held the
// connection open for the whole tool loop, sending nothing for ~10 seconds.
// Safari on the phone dropped that idle request and showed "Load failed" even
// though the server had finished the work successfully and logged no error.
// Now every HTTP request returns in well under a second and the page polls,
// so there is no long-lived idle connection to drop.
const jobs = new Map();       // jobId -> job
const jobByUser = new Map();  // username -> id of that user's RUNNING job
const RUNNING_ABANDON_MS = 8 * 60 * 1000;   // a stuck job is given up on
const FINISHED_RETAIN_MS = 10 * 60 * 1000;  // a finished answer waits to be collected

function reapJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status === 'running' && now - j.createdAt > RUNNING_ABANDON_MS) {
      j.status = 'error';
      j.error = 'That took too long and was abandoned. Please send it again.';
      j.finishedAt = now;
      if (jobByUser.get(j.username) === id) jobByUser.delete(j.username);
    } else if (j.status !== 'running' && now - (j.finishedAt || j.createdAt) > FINISHED_RETAIN_MS) {
      jobs.delete(id);
    }
  }
}

// Every exchange is recorded, including the ones that changed nothing, so
// "what did staff ask and what did it answer" is reviewable later. Logging
// must never break a reply, hence the swallowed error.
function logInteraction(ctx, { username, message, result, error, ms, toolCalls, queries }) {
  try {
    const db = new Database(ctx.dbPath);
    try {
      db.prepare(`
        INSERT INTO assistant_log
          (username, message, reply, pending_summary, executed, error, duration_ms, model,
           tool_calls, queries, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        username || null,
        message || null,
        result ? result.reply : null,
        result ? result.pendingSummary || null : null,
        result ? result.executed || null : null,
        error || null,
        ms,
        MODEL,
        toolCalls && toolCalls.length ? JSON.stringify(toolCalls) : null,
        typeof queries === 'number' ? queries : null
      );
    } finally {
      db.close();
    }
  } catch (err) {
    console.error('[assistant] could not write assistant_log:', err.message);
  }
}

function startJob(ctx, args) {
  reapJobs();

  // One running job per user. Without this, a second tab - or an impatient
  // re-send after a dropped poll - starts a duplicate run and doubles the
  // spend on the same question.
  const existingId = jobByUser.get(args.username);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && existing.status === 'running') {
      // This question is NOT answered: the page will collect the previous
      // job's answer instead. Log it regardless - otherwise "log every
      // question" silently loses precisely the questions that went
      // unanswered, which are the ones worth reviewing.
      logInteraction(ctx, {
        username: args.username,
        message: args.message,
        error: 'Not processed - another question from this user was still running.',
        ms: 0,
      });
      return { jobId: existingId, reused: true };
    }
    jobByUser.delete(args.username);
  }

  const id = require('crypto').randomUUID();
  const started = Date.now();
  const job = {
    id, sessionId: args.sessionId, username: args.username,
    status: 'running', createdAt: started, queries: 0, tools: [],
  };
  jobs.set(id, job);
  jobByUser.set(args.username, id);

  // Deliberately not awaited: the caller responds immediately with the id.
  handleMessage(ctx, {
    ...args,
    onProgress: (p) => {
      job.queries = p.queries;
      job.tools = p.tools;
      if (p.trail) job.trail = p.trail;
    },
  })
    .then((result) => {
      job.status = 'done';
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      console.error('[assistant] job failed:', err);
      job.status = 'error';
      job.error = err.userFacing ? err.message : 'The assistant is unavailable right now.';
      job.finishedAt = Date.now();
    })
    .finally(() => {
      if (jobByUser.get(args.username) === id) jobByUser.delete(args.username);
      const ms = Date.now() - started;
      // Logged either way: a failed question is as worth reviewing as an answer.
      logInteraction(ctx, {
        username: args.username, message: args.message,
        result: job.result, error: job.error, ms,
        toolCalls: job.trail, queries: job.queries,
      });
      console.log(
        `[assistant] ${args.username} ${job.status} in ${ms}ms after ${job.queries} query/queries` +
        `${job.result && job.result.executed ? ' (EXECUTED)' : ''}`
      );
    });

  return { jobId: id, reused: false };
}

/** Scoped to the session, so one user's job id cannot read another's result. */
function getJob(sessionId, id) {
  reapJobs();
  const job = jobs.get(id);
  if (!job || job.sessionId !== sessionId) return null;

  const elapsedMs = (job.finishedAt || Date.now()) - job.createdAt;
  if (job.status === 'running') {
    return { status: 'running', elapsedMs, queries: job.queries, tools: job.tools };
  }
  if (job.status === 'error') return { status: 'error', error: job.error, elapsedMs };

  // A finished answer is KEPT for FINISHED_RETAIN_MS rather than dropped on
  // first collection: a phone that was asleep when the answer landed must
  // still be able to pick it up. Re-reading only re-displays the reply - the
  // database change happened once, and its pending entry is already cleared.
  return { status: 'done', elapsedMs, queries: job.queries, ...job.result };
}

module.exports = { handleMessage, startJob, getJob, getPending, clearPending, CONFIRM_LINE, MODEL };

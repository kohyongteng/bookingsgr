import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { TEMPLATES } from './templates.js';

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

// Same shared-data root as OUTBOX_DIR (config.js), but this bot has no Gmail
// access of its own - it just drops a file here for email-processor's
// detector.js to pick up and actually send the alert email.
const GAP_ALERTS_DIR = 'C:\\apps\\shared-data\\gap-alerts';

function buildSystemPrompt() {
  const corpus = TEMPLATES.filter((t) => t.reply)
    .map((t) => `[${t.id}]\n${t.reply}`)
    .join('\n\n');

  return `You are auditing whether a guest's question - which did NOT match any of our existing
WhatsApp bot topics - could actually have been answered using our EXISTING reference material
below, just because the wording didn't match an existing topic's trigger phrasing, not because
the information is genuinely missing.

Only say "answerable" if the reference material below ACTUALLY contains a clear, confident
answer. If this is a genuinely new topic not covered anywhere below, say NOT answerable - do
not guess or invent an answer that isn't grounded in the material.

Reference material (each block is one existing topic's reply text):
---
${corpus}
---

Respond ONLY with JSON of this exact shape: {"answerable": boolean, "answer": string|null, "note": string|null}
- "answer": the answer, reusing wording from the reference material above rather than inventing new policy
- "note": one short sentence naming which existing topic's reply this came from, or why it's a genuinely new gap`;
}

/**
 * Checks whether an UNMATCHED guest question is actually answerable from
 * information already sitting in an existing template's reply text - i.e. a
 * "you're probably missing a template for this" signal, not a "this is a
 * brand new topic" signal (those stay silent - nothing to suggest yet).
 *
 * @param {{ text: string }} input
 * @returns {Promise<{ answerable: boolean, answer: string|null, note: string|null }>}
 */
export async function checkAnswerableGap({ text }) {
  try {
    const response = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: text?.trim() || '' }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const cleaned = (textBlock?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const parsed = JSON.parse(cleaned);
    return {
      answerable: Boolean(parsed?.answerable),
      answer: parsed?.answer || null,
      note: parsed?.note || null,
    };
  } catch (err) {
    console.error('[gapCheck] checkAnswerableGap failed:', err);
    return { answerable: false, answer: null, note: null }; // fail safe: no alert on error
  }
}

/** Drops a gap-alert file for email-processor's detector.js to email out. */
export function writeGapAlert({ question, answer, note, guestLabel }) {
  if (!fs.existsSync(GAP_ALERTS_DIR)) fs.mkdirSync(GAP_ALERTS_DIR, { recursive: true });
  const filename = `gap-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(GAP_ALERTS_DIR, filename),
    JSON.stringify({ question, answer, note, guestLabel, detectedAt: new Date().toISOString() }),
    'utf8'
  );
}

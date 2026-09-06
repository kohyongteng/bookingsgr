import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { TEMPLATES, UNMATCHED } from './templates.js';

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

// Build the topic list once — used in every classification prompt.
const TOPIC_LIST = TEMPLATES.map((t) => `- id: "${t.id}"\n  match when: ${t.matchWhen}`).join('\n');

const SYSTEM_PROMPT = `You are a strict intent classifier for a WhatsApp guest-service bot at a
short-stay apartment in Kuala Lumpur, Malaysia. You do NOT write replies — you only pick which
fixed topic(s) (if any) match the guest's message.

Guests write casually, with typos, broken English, Manglish, or abbreviations
(e.g. "wifi pw?", "can check in early anot", "where to park car", "aircon not on",
"how to throw rubbish"). Match on underlying intent, not exact wording.

IMPORTANT: a guest may ask about MULTIPLE distinct topics in one message, or send several
short messages close together that get combined into one block of text (e.g. "where is the
car park" followed by "also what's the wifi password" in the same block). Identify and
return EVERY distinct topic covered, not just the first or most prominent one.

Casual pleasantries and closing remarks with no actual question (thanks/ok/noted/👍) should
match "casual_ack" — but ONLY include "casual_ack" if the guest's message contains NOTHING
else (no real question alongside it). If a pleasantry is combined with an actual question,
just return the question's topic — the pleasantry doesn't need its own reply.

If the message could match more than one topic, prefer the more specific topic over "new_guest".

Include "${UNMATCHED}" in the list ONLY if there is a genuine piece of the guest's message that
isn't covered by any topic below — not merely because the wording differs from the example
phrasing. If everything is covered by real topics, do not include "${UNMATCHED}".

Topics:
${TOPIC_LIST}

Respond ONLY with a JSON object of the exact shape {"templateIds": [...]} — one or more of the
topic ids above and/or "${UNMATCHED}". No other text, no markdown code fence.`;

const VALID_IDS = new Set([...TEMPLATES.map((t) => t.id), UNMATCHED]);

function extractJson(text) {
  // Claude follows the "JSON only" instruction reliably, but strip a code
  // fence defensively in case one slips in.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

/**
 * Classify a guest's (already debounce-batched) message text against the fixed
 * template list. Returns EVERY distinct topic matched (not just one), so a guest
 * asking about car park AND wifi in the same burst gets both answered instead of
 * only the first.
 *
 * Text-only by design — photo/video/audio understanding stays on Gemini
 * (see gemini.js: classifyImage, transcribeAudio). This function has never been
 * called with an image in production; if that ever changes, route the image
 * case to Gemini rather than adding vision here.
 *
 * @param {{ text: string }} input
 * @returns {Promise<string[]>} one or more template ids from templates.js, and/or UNMATCHED
 */
export async function matchIntents({ text }) {
  try {
    const response = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text?.trim() || '(empty message)' }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const parsed = textBlock ? extractJson(textBlock.text) : null;
    const ids = Array.isArray(parsed?.templateIds) ? parsed.templateIds.filter((id) => VALID_IDS.has(id)) : [];
    const deduped = [...new Set(ids)];
    return deduped.length ? deduped : [UNMATCHED];
  } catch (err) {
    console.error('[claude] matchIntents failed, falling back to UNMATCHED:', err);
    return [UNMATCHED]; // fail safe: hand off to staff rather than guess
  }
}

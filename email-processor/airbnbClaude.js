// CommonJS port of whatsapp-bot/src/claude.js's matchIntents, adapted for
// airbnbTemplates.js. Kept separate (not shared) for the same ESM/CommonJS
// reason airbnbTemplates.js is separate - see the plan.

const Anthropic = require('@anthropic-ai/sdk');
const { TEMPLATES, UNMATCHED } = require('./airbnbTemplates');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOPIC_LIST = TEMPLATES.map((t) => `- id: "${t.id}"\n  match when: ${t.matchWhen}`).join('\n');

const SYSTEM_PROMPT = `You are a strict intent classifier for a short-stay apartment's Airbnb guest
chat (relayed via email). You do NOT write replies — you only pick which fixed topic(s) (if any)
match the guest's message.

Guests write casually, with typos, broken English, or abbreviations (e.g. "wifi pw?",
"can check in early anot", "where to park car", "aircon not on", "how to throw rubbish").
Match on underlying intent, not exact wording.

IMPORTANT: a guest may ask about MULTIPLE distinct topics in one message. Identify and return
EVERY distinct topic covered, not just the first or most prominent one.

Casual pleasantries and closing remarks with no actual question (thanks/ok/noted) should match
"casual_ack" — but ONLY include "casual_ack" if the guest's message contains NOTHING else.

If the message could match more than one topic, prefer the more specific topic over "new_guest".

Include "${UNMATCHED}" in the list ONLY if there is a genuine piece of the guest's message that
isn't covered by any topic below. If everything is covered by real topics, do not include "${UNMATCHED}".

Topics:
${TOPIC_LIST}

Respond ONLY with a JSON object of the exact shape {"templateIds": [...]} — one or more of the
topic ids above and/or "${UNMATCHED}". No other text, no markdown code fence.`;

const VALID_IDS = new Set([...TEMPLATES.map((t) => t.id), UNMATCHED]);

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

/**
 * Classify a guest's Airbnb chat message against the fixed template list.
 * @param {{ text: string }} input
 * @returns {Promise<string[]>} one or more template ids, and/or UNMATCHED
 */
async function matchIntents({ text }) {
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
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
    console.error('[airbnbClaude] matchIntents failed, falling back to UNMATCHED:', err);
    return [UNMATCHED];
  }
}

module.exports = { matchIntents };

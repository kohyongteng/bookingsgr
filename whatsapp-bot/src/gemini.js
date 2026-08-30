import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { TEMPLATES, UNMATCHED } from './templates.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// Build the topic list once — used in every classification prompt.
const TOPIC_LIST = TEMPLATES.map((t) => `- id: "${t.id}"\n  match when: ${t.matchWhen}`).join('\n');

const SYSTEM_INSTRUCTION = `You are a strict intent classifier for a WhatsApp guest-service bot at a
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

Respond ONLY with the JSON object described by the schema. No other text.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    templateIds: {
      type: 'array',
      description: 'Every distinct topic id that matches something in the guest\'s message. Include UNMATCHED only for a genuinely uncovered part.',
      items: {
        type: 'string',
        enum: [...TEMPLATES.map((t) => t.id), UNMATCHED],
      },
      minItems: 1,
    },
  },
  required: ['templateIds'],
};

/**
 * Classify a guest's (already debounce-batched) message text, optionally with one
 * attached image (e.g. an ID photo), against the fixed template list. Returns EVERY
 * distinct topic matched (not just one), so a guest asking about car park AND wifi
 * in the same burst gets both answered instead of only the first.
 *
 * @param {{ text: string, image?: { base64: string, mimeType: string } }} input
 * @returns {Promise<string[]>} one or more template ids from templates.js, and/or UNMATCHED
 */
export async function matchIntents({ text, image }) {
  const parts = [{ text: text?.trim() || '(no text — see attached image)' }];
  if (image) {
    parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } });
  }

  const validIds = new Set([...TEMPLATES.map((t) => t.id), UNMATCHED]);

  try {
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: 'minimal' }, // high-volume classification — no need for deep reasoning
      },
    });

    const parsed = JSON.parse(response.text);
    const ids = Array.isArray(parsed?.templateIds) ? parsed.templateIds.filter((id) => validIds.has(id)) : [];
    const deduped = [...new Set(ids)];
    return deduped.length ? deduped : [UNMATCHED];
  } catch (err) {
    console.error('[gemini] matchIntents failed, falling back to UNMATCHED:', err);
    return [UNMATCHED]; // fail safe: hand off to staff rather than guess
  }
}

const IMAGE_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    isIdDocument: {
      type: 'boolean',
      description: 'true if this photo is a passport, Malaysian IC, or driving licence submitted for guest identity verification',
    },
    oneLineDescription: {
      type: 'string',
      description: 'A short one-line description of what the photo shows, for a staff forwarding caption (e.g. "broken AC remote", "screenshot of booking confirmation").',
    },
  },
  required: ['isIdDocument', 'oneLineDescription'],
};

/**
 * Classify a guest-sent photo: is it an ID document (passport/IC/licence), and if
 * not, a short caption describing it for the staff-forward message.
 *
 * @param {{ base64: string, mimeType: string, captionText?: string }} image
 * @returns {Promise<{ isIdDocument: boolean, oneLineDescription: string }>}
 */
export async function classifyImage({ base64, mimeType, captionText }) {
  try {
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Look at this guest-sent photo from a short-stay apartment WhatsApp bot. ' +
                'Decide if it is a passport / Malaysian IC / driving licence photo submitted ' +
                'for identity verification, or something else (e.g. a broken appliance, a ' +
                'screenshot, a general photo). ' +
                (captionText ? `Guest's caption text: "${captionText}". ` : '') +
                'Respond ONLY with the JSON object described by the schema.',
            },
            { inlineData: { data: base64, mimeType } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: IMAGE_CLASSIFY_SCHEMA,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    });
    const parsed = JSON.parse(response.text);
    return {
      isIdDocument: Boolean(parsed?.isIdDocument),
      oneLineDescription: parsed?.oneLineDescription || 'photo from guest',
    };
  } catch (err) {
    console.error('[gemini] classifyImage failed, treating as non-ID photo:', err);
    return { isIdDocument: false, oneLineDescription: 'photo from guest (auto-description failed)' };
  }
}

/**
 * Transcribe a voice note to plain text. Returns '' on failure (caller should
 * still forward to staff with a note that transcription failed).
 *
 * @param {{ base64: string, mimeType: string }} audio
 * @returns {Promise<string>}
 */
export async function transcribeAudio(audio) {
  try {
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe this voice message exactly as spoken. Respond with only the transcription, no commentary.' },
            { inlineData: { data: audio.base64, mimeType: audio.mimeType } },
          ],
        },
      ],
    });
    return (response.text || '').trim();
  } catch (err) {
    console.error('[gemini] transcribeAudio failed:', err);
    return '';
  }
}

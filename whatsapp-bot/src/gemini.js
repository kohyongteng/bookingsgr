import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// Text-based intent classification (matchIntents) has moved to claude.js.
// This file now only handles photo/video/audio understanding, which Claude's
// API can't do (no audio input) or which was deliberately kept on Gemini.

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

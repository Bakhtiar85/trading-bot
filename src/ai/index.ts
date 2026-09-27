/**
 * Claude API wrapper — used ONLY to write plain-English incident summaries for emails.
 *
 * SAFETY BOUNDARY: this module never returns anything but text, is given no tools, and its output
 * is never read by any trading code. It is called only AFTER the bot has already acted.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { IncidentContext } from '../types';

export const DISCLAIMER = 'This is not financial advice; you may want a second opinion before making further decisions.';

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You write short incident notices for the owner of an automated grid trading bot. The owner is not a trading expert.

You will receive structured JSON describing something that already happened. Write a 3-5 sentence plain-English summary covering: what happened, the price and range involved, the drawdown if given, and what the bot already did and its current status.

Rules:
- Only describe what already happened. Do not recommend, suggest, or imply any further trading action (no "consider buying", "you should sell", "wait for the price to recover", price predictions, or similar).
- Use the numbers exactly as given; do not invent facts. If a value is null, leave it out.
- If "testnet" is true, mention that this happened on the Binance test network with test funds.
- Plain prose only: no headings, bullet points, or markdown.
- End with exactly this sentence: "${DISCLAIMER}"`;

let client: Anthropic | null = null;

/**
 * Generate a plain-English summary of an incident. Returns text only; throws on any API failure
 * or refusal so the caller can fall back to a template.
 */
export async function generateIncidentSummary(context: IncidentContext): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  // Short timeout and a single retry: the email should not wait long on this.
  client ??= new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    // If a safety classifier declines, the API retries on a fallback model instead of failing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Incident data:\n${JSON.stringify(context, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to summarise this incident');

  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  if (text === '') throw new Error('Claude returned an empty summary');

  return text.includes(DISCLAIMER) ? text : `${text} ${DISCLAIMER}`;
}

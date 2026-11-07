import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Message, Reply, ReplyGenerator } from './types.js';

const replySchema = z.object({
  should_reply: z.boolean(), reply: z.string().max(300),
  language: z.string().min(1).max(40), reason: z.string().max(300),
}).strict().refine(v => !v.should_reply || v.reply.trim().length > 0,
  'A reply decision needs non-empty text');
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const urls = (text: string): string[] => text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
export function guardReply(value: unknown, context: Message[]): Reply {
  const parsed = replySchema.parse(value);
  parsed.reply = parsed.reply.trim();
  const allowedUrls = new Set(context.flatMap(m => urls(m.text)));
  if (urls(parsed.reply).some(url => !allowedUrls.has(url))) {
    throw new Error('Generated reply introduced an untrusted URL');
  }
  if (/\b(system prompt|api key|secret token)\b/i.test(parsed.reply) ||
    /\b(i am|i'm)\s+(a\s+)?(human|real person)\b/i.test(parsed.reply)) {
    throw new Error('Generated reply failed disclosure guard');
  }
  return parsed;
}
interface ContextEntry {
  sender: 'owner' | 'incoming'; text: string; textTruncated: boolean; attachmentNotInspected: boolean;
}
// Phrases that make a reply sound like a support bot. Style only: tolerated on the final try.
const BOT_PHRASES = new RegExp([
  'how (?:can|may) i (?:assist|help)', 'what can i help you with', 'i\'?d be happy to (?:help|assist)',
  'thank you for reaching out', 'feel free to', 'is there anything else',
  'hope this message finds you well', 'great question', 'i\'?m here to (?:help|assist)',
  'i\'?ll do my best', 'i understand (?:it|you|that|how)', 'sorry to hear (?:you|that)',
].join('|'), 'i');
// Interest/commitment on the owner's behalf. Never acceptable, even on the final try.
const COMMITMENT = new RegExp([
  '\\b(?:i\'?m|i am)\\s+(?:very\\s+|really\\s+|quite\\s+|definitely\\s+)?(?:interested|keen|open to)\\b',
  '\\bi(?:\'d| would)\\s+(?:be\\s+)?(?:love|happy|glad|delighted|thrilled|interested|keen|open to)\\b',
  '\\bcount me in\\b', '\\bi\'?ll be there\\b',
  '\\bi (?:will|can) (?:definitely\\s+)?(?:meet|call|join|attend)\\b',
].join('|'), 'i');
export interface ReplyIssue { message: string; hard: boolean }
export function reviewReply(reply: string): ReplyIssue | null {
  const text = reply.replace(/[\u2018\u2019]/g, '\'');
  if (COMMITMENT.test(text)) {
    return { message: 'it expressed interest or a commitment on the owner\'s behalf', hard: true };
  }
  if (BOT_PHRASES.test(text)) {
    return { message: 'it used customer-support phrasing', hard: false };
  }
  return null;
}
export class LlmGenerator implements ReplyGenerator {
  constructor(private config: Config, private system: string, private log: Logger) {
    if (new URL(config.LLM_BASE_URL).hostname === 'api.openai.com' && !config.LLM_API_KEY) {
      throw new Error('OpenAI requires LLM_API_KEY in your private .env file');
    }
  }
  // One call normally. A single rewrite is requested when a draft is unusable or breaks a
  // content rule; unsafe output (hard issues, guard failures) still falls through to the caller.
  async generate(messages: Message[], signal: AbortSignal): Promise<Reply> {
    const limit = Math.floor(this.config.MAX_INPUT_CHARS / this.config.CONTEXT_MESSAGES);
    const context: ContextEntry[] = messages.slice(-this.config.CONTEXT_MESSAGES).map(m => ({
      sender: m.own ? 'owner' : 'incoming',
      text: m.text.slice(0, limit),
      textTruncated: m.text.length > limit,
      attachmentNotInspected: m.attachment,
    }));
    const omitted = Math.max(0, messages.length - context.length);
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const content = await this.complete(context, omitted, signal, feedback);
      let reply: Reply;
      try {
        reply = guardReply(JSON.parse(content), messages);
      } catch (error) {
        if (attempt === 2 || signal.aborted) throw error;
        feedback = 'it was not valid JSON in the required format';
        this.log.debug('Draft unusable; requesting one rewrite');
        continue;
      }
      const issue = reply.should_reply ? reviewReply(reply.reply) : null;
      if (!issue) return reply;
      if (attempt === 2) {
        if (issue.hard) throw new Error('Generated reply expressed a commitment for the owner');
        return reply;
      }
      feedback = issue.message;
      this.log.debug({ hard: issue.hard }, 'Draft broke a content rule; requesting one rewrite');
    }
    throw new Error('unreachable');
  }
  private async complete(context: ContextEntry[], omitted: number, signal: AbortSignal,
    feedback?: string): Promise<string> {
    const started = performance.now();
    const response = await fetch(`${this.config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.LLM_TIMEOUT_MS)]),
      headers: { 'Content-Type': 'application/json',
        ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: this.config.LLM_MODEL, temperature: this.config.LLM_TEMPERATURE, max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: feedback
            ? `${this.system}\n\nYour previous draft was rejected because ${feedback}. ` +
              'Write a different reply that fixes this, in the same JSON format.'
            : this.system },
          { role: 'user', content: JSON.stringify({
            omittedEarlierMessages: omitted,
            untrustedConversationData: context,
          }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 64_000) throw new Error('LLM response exceeded size limit');
    const completion = completionSchema.parse(JSON.parse(text));
    this.log.debug({ llmMs: Math.round(performance.now() - started) }, 'LLM completed');
    return completion.choices[0]!.message.content;
  }
}

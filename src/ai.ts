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
export class LlmGenerator implements ReplyGenerator {
  constructor(private config: Config, private system: string, private log: Logger) {
    if (new URL(config.LLM_BASE_URL).hostname === 'api.openai.com' && !config.LLM_API_KEY) {
      throw new Error('OpenAI requires LLM_API_KEY in your private .env file');
    }
  }
  async generate(messages: Message[], signal: AbortSignal): Promise<Reply> {
    const context = messages.slice(-this.config.CONTEXT_MESSAGES).map(m => ({
      sender: m.own ? 'owner' : 'incoming',
      text: m.text.slice(0, Math.floor(this.config.MAX_INPUT_CHARS /
        this.config.CONTEXT_MESSAGES)),
      textTruncated: m.text.length > Math.floor(this.config.MAX_INPUT_CHARS /
        this.config.CONTEXT_MESSAGES),
      attachmentNotInspected: m.attachment,
    }));
    const started = performance.now();
    const response = await fetch(`${this.config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.LLM_TIMEOUT_MS)]),
      headers: { 'Content-Type': 'application/json',
        ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: this.config.LLM_MODEL, temperature: .6, max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: this.system },
          { role: 'user', content: JSON.stringify({
            omittedEarlierMessages: Math.max(0, messages.length - context.length),
            untrustedConversationData: context,
          }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 64_000) throw new Error('LLM response exceeded size limit');
    const completion = completionSchema.parse(JSON.parse(text));
    const reply = guardReply(JSON.parse(completion.choices[0]!.message.content), messages);
    this.log.debug({ llmMs: Math.round(performance.now() - started) }, 'LLM completed');
    return reply;
  }
}

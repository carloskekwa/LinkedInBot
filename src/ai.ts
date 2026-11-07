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
  'i\'?m (?:happy|glad|delighted|thrilled) to (?:help|assist)', 'i can\'?t share (?:that|this)',
].join('|'), 'i');
// Interest/commitment on the owner's behalf. Never acceptable, even on the final try.
const COMMITMENT = new RegExp([
  '\\b(?:i\'?m|i am)\\s+(?:\\w+ly\\s+|always\\s+|also\\s+|just\\s+)?(?:interested|keen|open to)\\b',
  '\\b(?:i\'?m|i am)\\s+(?:\\w+ly\\s+|always\\s+|more than\\s+)?(?:happy|glad|delighted|thrilled|excited|eager|keen)\\s+to\\b',
  '\\bi(?:\'d| would)\\s+(?:be\\s+)?(?:love|happy|glad|delighted|thrilled|interested|keen|open to)\\b',
  '\\bcount me in\\b', '\\bi\'?ll be there\\b',
  '\\bi (?:will|can) (?:definitely\\s+)?(?:meet|call|join|attend)\\b',
  // Turning down or accepting something (jobs, opportunities, availability) is the owner's call.
  '\\bnot (?:at the moment|right now|currently|really looking|looking)\\b',
  '\\bi\'?m not (?:looking|open|interested|available)\\b',
  '\\bi\'?m (?:currently\\s+)?(?:looking for|available|open)\\b',
].join('|'), 'i');
export interface ReplyIssue { message: string; hard: boolean; safeReply?: string }
// Neutral lines that make no claim and no commitment, used if a rewrite still breaks a rule.
const SAFE_ABOUT_OWNER = 'It\'s on my profile if you want to take a look.';
const SAFE_COMMITMENT = 'Could you share a few more details?';

// First-person claims about the owner that need support in the approved facts.
const CLAIMS: RegExp[] = [
  /\bi(?:'m| am)\s+(?:currently\s+|also\s+)?(?:based|located|living|from)\s+(?:in|at|near|around)?\s*([^.,!?;:]{2,50})/gi,
  /\bi\s+(?:currently\s+|also\s+)?(?:live|work|study)\s+(?:in|at|for|with|on|as)\s+([^.,!?;:]{2,50})/gi,
  /\bi(?:'m| am)\s+(?:currently\s+)?(?:working|studying)\s+(?:in|at|for|with|on|as)\s+([^.,!?;:]{2,50})/gi,
  /\bi(?:'m| am)\s+(?:an?|the)\s+(?!bit\b|little\b|lot\b|fan\b|big\b|huge\b|great\b|good\b|bad\b)([^.,!?;:]{2,50})/gi,
  /\bi\s+(?:really\s+)?(?:don't|do not|can't|cannot|never)\s+(?:\w+ly\s+)?(?:really\s+)?(?:work|specialize|specialise|focus|concentrate|do|use|code|program)\s+(?:with|in|on)?\s*([^.,!?;:]{2,50})/gi,
  /\bi\s+(?:mainly\s+|mostly\s+|primarily\s+)?(?:specialize|specialise|focus|concentrate)\s+(?:in|on|with)\s+([^.,!?;:]{2,50})/gi,
  /\bi(?:'ve| have)\s+(?:been\s+\w+\s+)?(?:for\s+)?(\d+\+?\s*(?:years?|months?)[^.,!?;:]{0,30})/gi,
  /\bi(?:'ve| have)\s+(?:worked|built|used|done|shipped)\s+(?:with|on|at|for|in)?\s*([^.,!?;:]{2,50})/gi,
  /\bmy\s+(?:role|job|title|background|expertise|experience|company|employer)\s+(?:is|involves|includes|centers on)\s+([^.,!?;:]{2,50})/gi,
  // Any claimed amount of experience ("10 years", "several years", "years of experience").
  /\bi(?:'ve| have|'m| am)?\b[^.!?]{0,70}?\b(\d+\+?|several|many|a few|a couple of|decades?)\s+(?:years?|decades?)\b/gi,
  /\bi(?:'ve| have)\s+(?:got\s+)?(?:years|decades|plenty|lots|a lot|a wealth)\s+of\s+([^.,!?;:]{2,30})/gi,
  /\b(?:focusing|specializing|specialising|concentrating)\s+(?:on|in)\s+([^.,!?;:]{2,50})/gi,
];
// Asserting what the owner's profile contains is also an unverifiable claim.
const PROFILE_CLAIM = /\b(?:mentioned|listed|noted|written|described|shown|detailed)\s+(?:on|in)\s+my\s+(?:profile|bio|about|headline)\b/i;
const CLAIM_STOP = new Set(['the', 'and', 'for', 'with', 'currently', 'also', 'based', 'mainly', 'mostly',
  'a', 'an', 'as', 'at', 'in', 'on', 'of', 'to', 'is', 'it', 'my', 'me', 'by', 'or', 'so', 'be', 'am', 'i']);
// "It's not something I focus on" and similar denials can never be backed by facts.
const DENIAL = /(?:\bnot|n't|\bnever)\s+(?:really\s+)?something\s+i\s+(?:\w+ly\s+)?(?:focus|specialize|specialise|do|work|use|know)\b/i;
const SELF_DISCLOSURE = /^(?:an?\s+)?(?:automated|assistant|ai|bot|virtual|digital)\b/i;
const wordsOf = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
// Returns the first unsupported claim about the owner, or null. Questions are never claims.
export function ownerClaimIssue(reply: string, facts: string[]): string | null {
  const factWords = wordsOf(facts.join(' '));
  const supported = (word: string): boolean => factWords.some(f => f === word ||
    (word.length >= 4 && f.length >= 4 && (f.startsWith(word) || word.startsWith(f))));
  const text = reply.replace(/[\u2018\u2019]/g, '\'');
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.trim().endsWith('?')) continue;
    for (const pattern of CLAIMS) {
      for (const match of sentence.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const claim = match[1]!.trim();
        if (SELF_DISCLOSURE.test(claim)) continue;
        const missing = wordsOf(claim).filter(w => (w.length >= 2 || /\d/.test(w)) &&
          !CLAIM_STOP.has(w) && !supported(w));
        if (missing.length > 0) return claim;
      }
    }
  }
  return null;
}
export function reviewReply(reply: string, facts: string[] = []): ReplyIssue | null {
  const text = reply.replace(/[\u2018\u2019]/g, '\'');
  if (COMMITMENT.test(text)) {
    return { message: 'it expressed interest or a commitment on the owner\'s behalf', hard: true,
      safeReply: SAFE_COMMITMENT };
  }
  if (ownerClaimIssue(reply, facts) !== null || PROFILE_CLAIM.test(text) || DENIAL.test(text)) {
    return { message: 'it stated personal facts about the owner, or what their profile contains, that are ' +
      'not in the approved facts. Do not guess or deny anything: say you are not sure, or just point to ' +
      'the owner\'s profile without describing it', hard: true, safeReply: SAFE_ABOUT_OWNER };
  }
  if (BOT_PHRASES.test(text)) {
    return { message: 'it used customer-support phrasing', hard: false };
  }
  return null;
}
export class LlmGenerator implements ReplyGenerator {
  constructor(private config: Config, private system: string, private log: Logger,
    private ownerFacts: string[] = []) {
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
      const issue = reply.should_reply ? reviewReply(reply.reply, this.ownerFacts) : null;
      if (!issue) return reply;
      if (attempt === 2) {
        if (!issue.hard) return reply;
        // Still unsafe after the rewrite: swap in a neutral line rather than a robotic fallback.
        // The canned lines are English, so other languages go to the generic fallback instead.
        if (issue.safeReply && /^en\b/i.test(reply.language)) {
          this.log.warn({ hard: true }, 'Rewrite still broke a rule; sending a neutral substitute');
          return { should_reply: true, reply: issue.safeReply, language: reply.language,
            reason: 'neutral substitute after rule violation' };
        }
        throw new Error('Generated reply made an unsupported claim or commitment for the owner');
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

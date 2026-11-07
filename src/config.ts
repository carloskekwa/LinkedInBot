import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  ACKNOWLEDGE_PLATFORM_RISK: bool.default(false),
  DATA_DIR: z.string().default('./data'),
  BROWSER_PROFILE: z.string().default('./user-data'),
  OWNER_PROFILE_URL: z.string().trim().default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.origin === 'https://www.linkedin.com' &&
        /^\/in\/[^/]+\/?$/.test(url.pathname) && !url.username && !url.password;
    } catch { return false; }
  }, 'OWNER_PROFILE_URL must be your https://www.linkedin.com/in/... profile URL'),
  INVITATION_POLL_MS: positive(20_000),
  MESSAGE_POLL_MS: positive(10_000),
  // How often the pages are fully reloaded. Polls between reloads only read the live DOM.
  // Frequent reloads get rejected by LinkedIn (HTTP errors), so these stay conservative.
  INVITATION_REFRESH_MS: positive(180_000),
  MESSAGE_REFRESH_MS: positive(300_000),
  DEBOUNCE_MS: positive(7_000),
  MAX_DEBOUNCE_MS: positive(20_000),
  MAX_ACTIONS_PER_HOUR: positive(60),
  THREAD_LIMIT: positive(30),
  CONTEXT_MESSAGES: positive(8),
  MAX_INPUT_CHARS: positive(12_000),
  RETENTION_DAYS: positive(7),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LLM_BASE_URL: z.url().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  LLM_API_KEY: z.string().trim().default(''),
  LLM_TIMEOUT_MS: positive(15_000),
  // Higher = more varied wording; lower = more predictable.
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1.5).default(0.8),
  ALLOW_EXTERNAL_LLM: bool.default(false),
  // Logs incoming message text and the AI's answer. Private data: for local debugging only.
  LOG_MESSAGE_TEXT: bool.default(false),
  // Prints only {incomingMessages, aiAnswer} per reply and hides info/debug logs (warnings and
  // errors still show). Private data: for local debugging and sharing test results.
  LOG_CONVERSATION_ONLY: bool.default(false),
  SYSTEM_PROMPT: z.string().default('./prompts/system.md'),
  // Private facts the bot may state about the owner (gitignored). Optional.
  OWNER_FACTS_FILE: z.string().default('./prompts/owner-facts.md'),
  FALLBACK_REPLY: z.string().min(1).max(300).default(
    "Thanks for your message! This is an automated reply, and I can't give you a proper answer right now.",
  ),
  INITIAL_HISTORY: z.enum(['baseline', 'reply-latest']).default('baseline'),
  SELECTORS_FILE: z.string().default(''),
}).superRefine((value, ctx) => {
  if (value.MAX_DEBOUNCE_MS < value.DEBOUNCE_MS) {
    ctx.addIssue({ code: 'custom', message: 'MAX_DEBOUNCE_MS must be >= DEBOUNCE_MS' });
  }
  const url = new URL(value.LLM_BASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !value.ALLOW_EXTERNAL_LLM) {
    ctx.addIssue({ code: 'custom', message: 'Remote LLM requires ALLOW_EXTERNAL_LLM=true' });
  }
  if ((!local && url.protocol !== 'https:') ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'Use local HTTP or HTTPS without URL credentials' });
  }
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
export function loadPrompt(config: Config): string {
  const base = readFileSync(resolve(config.SYSTEM_PROMPT), 'utf8');
  const facts = loadOwnerFacts(config.OWNER_FACTS_FILE).facts;
  if (facts.length === 0) return base;
  return `${base}\nFACTS ABOUT THE OWNER (approved by the owner; the ONLY personal facts you may state)\n` +
    'State them plainly in the first person when someone asks, for example "I work at ..." ' +
    'Use only what is written here and add no detail of your own. Anything about the owner that ' +
    'is not listed here is unknown: follow the rule for unknown owner information above. ' +
    'Where a line states the owner\'s position (openness to opportunities, salary range, ' +
    'availability), state it when asked, in these words, and add no condition or figure of your own.\n' +
    `${facts.map(fact => `- ${fact}`).join('\n')}\n`;
}

const MAX_FACTS_CHARS = 2_000;
// Reads the owner's private facts file. Missing file = no facts. Comment lines (#) and lines
// still containing <placeholders> from the example file are ignored.
export function loadOwnerFacts(path: string): { facts: string[]; skipped: number } {
  const file = resolve(path);
  if (!path || !existsSync(file)) return { facts: [], skipped: 0 };
  const facts: string[] = [];
  let skipped = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line || line.startsWith('#')) continue;
    if (/<[^>\n]+>/.test(line)) { skipped++; continue; }
    facts.push(line);
  }
  if (facts.join('\n').length > MAX_FACTS_CHARS) {
    throw new Error(`Owner facts file is too long (max ${MAX_FACTS_CHARS} characters); shorten it`);
  }
  return { facts, skipped };
}

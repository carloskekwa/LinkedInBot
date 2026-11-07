import { loadConfig } from './config.js';
import { Bot } from './runtime.js';
import { Store } from './storage.js';
import { report } from './metrics.js';
import { hash } from './time.js';
import type { Logger } from 'pino';
import type { Invitation, LinkedInPort, Message, Thread } from './types.js';

export class FakeAdapter implements LinkedInPort {
  loggedIn = true;
  pending: Invitation[] = [];
  threads = new Map<string, Thread>();
  accepted = new Set<string>();
  sent: { id: string; text: string }[] = [];
  uncertainSend = false;
  uncertainAccept = false;
  throwAfterSend = false;
  closed = false;
  async authenticated(): Promise<boolean> { return this.loggedIn; }
  async invitations(): Promise<Invitation[]> { return structuredClone(this.pending); }
  async accept(id: string, beforeClick: () => void): Promise<void> {
    beforeClick();
    this.accepted.add(id);
    this.pending = this.pending.filter(i => i.id !== id);
  }
  async verifyAcceptance(id: string) {
    return !this.uncertainAccept && this.accepted.has(id) ? 'confirmed' as const : 'uncertain' as const;
  }
  async conversations(): Promise<string[]> { return [...this.threads.keys()]; }
  async thread(id: string): Promise<Thread> {
    const thread = this.threads.get(id);
    if (!thread) throw new Error('Missing fake thread');
    return structuredClone(thread);
  }
  async send(id: string, text: string, beforeClick: () => void): Promise<void> {
    beforeClick();
    this.sent.push({ id, text });
    this.threads.get(id)!.messages.push({
      id: `own-${this.sent.length}`, own: true, text, attachment: false,
      transportConfirmed: true,
      receipt: { at: Date.now(), precision: 'exact', uncertaintyMs: 0 },
    });
    if (this.throwAfterSend) throw new Error('Synthetic timeout after send');
  }
  async verifySend(id: string, textHash: string, afterMessageId: string) {
    const messages = this.threads.get(id)?.messages ?? [];
    const anchor = messages.findIndex(m => m.id === afterMessageId);
    return !this.uncertainSend && anchor >= 0 && messages.slice(anchor + 1)
      .some(m => m.own && hash(m.text) === textHash) ? 'confirmed' as const : 'uncertain' as const;
  }
  async close(): Promise<void> { this.closed = true; }
}
export const syntheticMessage = (id: string, text = 'Hello!'): Message => ({
  id, own: false, text, attachment: false,
  receipt: { at: 1_700_000_000_000, precision: 'exact', uncertaintyMs: 0 },
});
export async function demo(log: Logger): Promise<void> {
  const config = loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    DEBOUNCE_MS: '1', MAX_DEBOUNCE_MS: '1',
    INITIAL_HISTORY: 'reply-latest' });
  const store = new Store(':memory:');
  try {
    const fake = new FakeAdapter();
    let now = 1_700_000_000_100;
    fake.pending = [{ id: 'synthetic-invitation', receipt: syntheticMessage('a').receipt }];
    fake.threads.set('synthetic-thread', { id: 'synthetic-thread', supported: true,
      messages: [syntheticMessage('m1')] });
    const bot = new Bot(fake, store, {
      async generate() { return { should_reply: true, reply: 'Hello! How can I help?',
        language: 'en', reason: 'synthetic demo' }; },
    }, config, log, true, new AbortController().signal, () => now);
    await bot.invitationTick();
    await bot.messageTick();
    now += 10;
    await bot.messageTick();
    await bot.messageTick();
    log.info({ invitations: fake.accepted.size, replies: fake.sent.length },
      'SYNTHETIC demo completed; no LinkedIn or LLM contacted');
    console.log(JSON.stringify({ syntheticOnly: true, metrics: report(store.all()) }, null, 2));
  } finally { store.close(); }
}

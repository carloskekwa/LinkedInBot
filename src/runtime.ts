import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { Store } from './storage.js';
import { backoffMs, isHttpRejection, safeDetail } from './errors.js';
import { hash, timing } from './time.js';
import type { Action, LinkedInPort, Message, ReplyGenerator, Thread } from './types.js';

// A thread that errors is left alone this long, so one broken thread cannot cause
// repeated page loads against LinkedIn.
const THREAD_COOLDOWN_MS = 120_000;
interface Batch { first: number; lastChange: number; signature: string }
export function incomingBatch(thread: Thread, store: Pick<Store, 'consumed'>): Message[] {
  if (!thread.supported || thread.messages.at(-1)?.own !== false) return [];
  const lastOwn = thread.messages.findLastIndex(m => m.own);
  return thread.messages.slice(lastOwn + 1).filter(m => !m.own && !store.consumed(m.id));
}

export class Bot {
  private readonly batches = new Map<string, Batch>();
  private readonly quarantine = new Map<string, number>();
  private lastHealthLog = 0;
  private lastPrune = 0;
  private initialThreads: Set<string> | undefined;
  constructor(
    private port: LinkedInPort, private store: Store,
    private generator: ReplyGenerator, private config: Config,
    private log: Logger, private live: boolean,
    private signal: AbortSignal,
    private now: () => number = Date.now,
  ) {}
  private checkStop(): void { this.signal.throwIfAborted(); }
  private canAct(): boolean {
    this.checkStop();
    if (this.store.recentAttempts(this.now()) >= this.config.MAX_ACTIONS_PER_HOUR) {
      this.log.warn('Hourly action cap reached; automation is waiting');
      return false;
    }
    return true;
  }
  private async active(worker: string): Promise<boolean> {
    this.checkStop();
    const ok = await this.port.authenticated();
    this.store.heartbeat(worker, ok ? 'active' : 'manual_login_required', this.now());
    if (!ok) this.log.error({ worker }, 'Manual login/checkpoint resolution required; actions paused');
    return ok;
  }
  private logConfirmation(action: Action): void {
    this.log.info({
      actionId: action.id, kind: action.kind, ref: hash(action.ref),
      receivedAt: action.receivedAt, receiptPrecision: action.precision,
      receiptUncertaintyMs: action.uncertaintyMs,
      detectedAt: action.detectedAt, handledAt: action.handledAt,
      confirmedAt: action.confirmedAt,
      receivedToConfirmedMs: action.receivedAt !== null && action.confirmedAt !== null
        ? action.confirmedAt - action.receivedAt : null,
      detectedToConfirmedMs: (action.confirmedAt ?? this.now()) - action.detectedAt,
      llmMs: action.llmMs, debounceMs: action.debounceMs,
    }, 'Action confirmed');
  }
  async reconcile(kind: Action['kind']): Promise<void> {
    for (const action of this.store.unresolved().filter(a => a.kind === kind)) {
      this.checkStop();
      const result = action.kind === 'reply' && action.textHash
        ? await this.port.verifySend(action.ref, action.textHash, action.incomingIds.at(-1)!)
        : await this.port.verifyAcceptance(action.ref);
      this.store.transition(action, result === 'confirmed' ? 'confirmed' : 'uncertain', this.now());
      if (result === 'confirmed') this.logConfirmation(action);
      else this.log.warn({ actionId: action.id, ref: hash(action.ref) },
        'Outcome uncertain; no resend/re-click. This item remains blocked for manual review');
    }
  }
  private dispatch(action: Action): () => void {
    return () => {
      this.checkStop();
      action.handledAt = this.now();
      this.store.save(action);
    };
  }
  async invitationTick(): Promise<void> {
    if (!await this.active('invitations')) return;
    await this.reconcile('invitation');
    const invitations = await this.port.invitations();
    for (const inv of invitations) {
      this.checkStop();
      const observed = this.store.observe(`inv:${inv.id}`, inv.id, inv.receipt, this.now());
      const key = `invitation:${inv.id}`;
      if (this.store.forKey(key)) continue;
      if (!this.live) {
        this.log.info({ ref: hash(inv.id), receivedAt: observed.receipt.at }, 'Dry-run: would accept');
        continue;
      }
      if (!this.canAct()) break;
      const action = this.store.create({
        kind: 'invitation', ref: inv.id, key, incomingIds: [`inv:${inv.id}`], textHash: null,
        timing: { receivedAt: observed.receipt.at, lastReceivedAt: observed.receipt.at,
          precision: observed.receipt.precision, uncertaintyMs: observed.receipt.uncertaintyMs,
          detectedAt: observed.detectedAt },
      });
      this.store.transition(action, 'executing', this.now());
      try {
        await this.port.accept(inv.id, this.dispatch(action));
        const result = await this.port.verifyAcceptance(inv.id);
        this.store.transition(action, result === 'confirmed' ? 'confirmed' : 'uncertain', this.now());
        if (result === 'confirmed') this.logConfirmation(action);
        else this.log.warn({ actionId: action.id }, 'Acceptance uncertain; will reconcile without clicking again');
      } catch (error) {
        this.store.transition(action, 'uncertain', this.now());
        this.log.error({ actionId: action.id, errorType: error instanceof Error ? error.name : 'unknown' },
          'Acceptance failed or outcome uncertain; paused this invitation');
        if (this.signal.aborted) throw error;
      }
    }
  }
  private observe(thread: Thread): void {
    for (const message of thread.messages) {
      const observation = this.store.observe(message.id, thread.id, message.receipt, this.now());
      message.receipt = observation.receipt;
    }
    // A manual owner reply also handles preceding inbound messages.
    const lastOwn = thread.messages.findLastIndex(m => m.own);
    if (lastOwn >= 0) this.store.consume(thread.messages.slice(0, lastOwn + 1).map(m => m.id));
    const known = this.initialThreads?.has(thread.id) === true;
    const stale = this.port.staleConversations?.().has(thread.id) === true;
    if (this.store.initializeConversation(thread.id) && this.config.INITIAL_HISTORY === 'baseline' &&
        (known || stale)) {
      this.store.consume(thread.messages.map(m => m.id));
      this.log.info({ ref: hash(thread.id), reason: known ? 'present at startup' : 'old activity surfaced late' },
        'Initial history baselined without replying');
    }
  }
  async messageTick(): Promise<void> {
    if (!await this.active('messages')) return;
    await this.reconcile('reply');
    const ids = (await this.port.conversations()).slice(0, this.config.THREAD_LIMIT);
    this.initialThreads ??= new Set(ids);
    for (const id of ids) {
      this.checkStop();
      if (this.store.unresolved(id).length) continue;
      if ((this.quarantine.get(id) ?? 0) > this.now()) continue;
      try {
        await this.processThread(id);
      } catch (error) {
        if (this.signal.aborted) throw error;
        // A rejection by LinkedIn affects every thread: stop the burst, let the worker back off.
        if (isHttpRejection(error)) throw error;
        // One unreadable thread must not stop the others or trigger a reload storm.
        this.quarantine.set(id, this.now() + THREAD_COOLDOWN_MS);
        this.batches.delete(id);
        this.log.warn({ ref: hash(id), detail: safeDetail(error),
          retryInSeconds: THREAD_COOLDOWN_MS / 1000 },
          'Thread skipped after an error; other threads continue');
      }
    }
  }
  private async processThread(id: string): Promise<void> {
    const thread = await this.port.thread(id);
    if (!thread.supported) return;
    this.observe(thread);
    const incoming = incomingBatch(thread, this.store);
    if (incoming.length === 0) { this.batches.delete(id); return; }
    const signature = hash(JSON.stringify(incoming.map(m => m.id)));
    const existing = this.batches.get(id);
    const batch = existing ?? { first: this.now(), lastChange: this.now(), signature };
    if (batch.signature !== signature) { batch.lastChange = this.now(); batch.signature = signature; }
    this.batches.set(id, batch);
    if (this.now() - batch.lastChange < this.config.DEBOUNCE_MS &&
        this.now() - batch.first < this.config.MAX_DEBOUNCE_MS) return;
    if (this.live && !this.canAct()) return;

    const start = performance.now();
    let reply;
    try {
      reply = await this.generator.generate(thread.messages, this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.log.error({ errorType: error instanceof Error ? error.name : 'unknown',
        detail: safeDetail(error), ref: hash(id) },
        'LLM unavailable or output invalid; using explicit automated-assistant fallback');
      reply = { should_reply: true, reply: this.config.FALLBACK_REPLY, language: 'unknown', reason: 'fallback' };
    }
    const llmMs = Math.round(performance.now() - start);
    // Debug only: the model's free-text reason may echo message content.
    this.log.debug({ ref: hash(id), shouldReply: reply.should_reply, language: reply.language,
      reason: reply.reason, llmMs }, 'Model decision');
    const generatedAt = this.now();
    this.checkStop();
    const fresh = await this.port.thread(id);
    if (!fresh.supported) { this.batches.delete(id); return; }
    this.observe(fresh);
    const freshIncoming = incomingBatch(fresh, this.store);
    if (hash(JSON.stringify(freshIncoming.map(m => m.id))) !== signature) {
      this.log.info({ ref: hash(id) }, 'Thread changed during generation; discarded stale draft');
      return;
    }
    if (!reply.should_reply) {
      this.store.consume(incoming.map(m => m.id));
      this.batches.delete(id);
      this.log.info({ ref: hash(id) }, 'No reply appropriate; batch handled without sending');
      return;
    }
    if (!this.live) {
      this.store.consume(incoming.map(m => m.id));
      this.batches.delete(id);
      this.log.info({ ref: hash(id), replyLength: reply.reply.length,
        replyHash: hash(reply.reply) }, 'Dry-run: would reply (body intentionally not logged)');
      return;
    }
    if (!this.canAct() || !await this.port.authenticated()) return;
    const first = this.store.observe(incoming[0]!.id, id, incoming[0]!.receipt, this.now());
    const action = this.store.create({
      kind: 'reply', ref: id, key: `reply:${id}:${signature}`,
      incomingIds: incoming.map(m => m.id), textHash: hash(reply.reply),
      timing: timing(incoming, first.detectedAt),
      generatedAt, llmMs, debounceMs: Math.max(0, generatedAt - batch.first - llmMs),
    });
    this.store.transition(action, 'executing', this.now());
    try {
      await this.port.send(id, reply.reply, this.dispatch(action));
      const result = await this.port.verifySend(id, hash(reply.reply), incoming.at(-1)!.id);
      this.store.transition(action, result === 'confirmed' ? 'confirmed' : 'uncertain', this.now());
      if (result === 'confirmed') this.logConfirmation(action);
      else this.log.warn({ actionId: action.id }, 'Send uncertain; no automatic retry');
    } catch (error) {
      this.store.transition(action, 'uncertain', this.now());
      this.log.error({ actionId: action.id, errorType: error instanceof Error ? error.name : 'unknown',
        detail: safeDetail(error) }, 'Send failed or outcome uncertain; conversation blocked until reconciled');
      if (this.signal.aborted) throw error;
    }
    this.batches.delete(id);
  }
  async run(): Promise<void> {
    const loop = async (worker: string, interval: number, tick: () => Promise<void>) => {
      let failures = 0;
      let rejected = false;
      while (!this.signal.aborted) {
        const started = performance.now();
        try {
          await tick();
          failures = 0;
          rejected = false;
        } catch (error) {
          if (this.signal.aborted) break;
          failures++;
          rejected = isHttpRejection(error);
          this.store.heartbeat(worker, rejected ? 'rejected_by_linkedin' : 'error', this.now());
          this.log.error({ worker, errorType: error instanceof Error ? error.name : 'unknown',
            detail: safeDetail(error),
            pauseSeconds: Math.round(backoffMs(failures, rejected) / 1000) },
          rejected
            ? 'LinkedIn rejected page loads (HTTP error, likely throttling). Pausing this worker; do not run other LinkedIn sessions meanwhile'
            : 'Worker failed; bounded backoff before retry (external writes are never replayed)');
        }
        if (this.now() - this.lastHealthLog >= 300_000) {
          this.lastHealthLog = this.now();
          this.log.info({ actions: this.store.all().length }, 'Heartbeat: worker loops running');
        }
        if (this.now() - this.lastPrune >= 3_600_000) {
          this.lastPrune = this.now();
          this.store.prune(this.now() - this.config.RETENTION_DAYS * 86_400_000);
        }
        const wait = failures ? backoffMs(failures, rejected) :
          Math.max(500, interval * (.8 + Math.random() * .4) - (performance.now() - started));
        try { await delay(wait, undefined, { signal: this.signal }); }
        catch (error) { if (!this.signal.aborted) throw error; }
      }
    };
    await Promise.all([
      loop('invitations', this.config.INVITATION_POLL_MS, () => this.invitationTick()),
      loop('messages', this.config.MESSAGE_POLL_MS, () => this.messageTick()),
    ]);
  }
}

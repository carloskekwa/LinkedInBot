import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { Store } from './storage.js';
import { backoffMs, isHttpRejection, safeDetail } from './errors.js';
import { hash, timing } from './time.js';
import type { Action, LinkedInPort, Message, ReplyGenerator, Thread, Verification } from './types.js';

// A thread that errors is left alone this long, so one broken thread cannot cause
// repeated page loads against LinkedIn.
const THREAD_COOLDOWN_MS = 120_000;
// A failure before the click changed nothing on LinkedIn, so the action may be retried a few
// times, pausing twice as long after each failure.
const MAX_PRECLICK_RETRIES = 3;
const RETRY_BASE_MS = 120_000;
const MAX_RECHECK_MS = 3_600_000;
// Delays before re-checking an uncertain outcome. Re-checking an invitation loads a profile
// page, which LinkedIn throttles, so it is done rarely; a reply check only reads the chat.
export function recheckDelayMs(kind: Action['kind'], tries: number): number {
  const steps = kind === 'reply' ? [0, 15_000, 60_000, 300_000] : [300_000, 600_000, 1_200_000];
  if (tries <= steps.length) return steps[tries - 1]!;
  return Math.min(MAX_RECHECK_MS, steps.at(-1)! * 2 ** (tries - steps.length));
}
interface Batch { first: number; lastChange: number; signature: string }
export function incomingBatch(thread: Thread, store: Pick<Store, 'consumed'>): Message[] {
  if (!thread.supported || thread.messages.at(-1)?.own !== false) return [];
  const lastOwn = thread.messages.findLastIndex(m => m.own);
  return thread.messages.slice(lastOwn + 1).filter(m => !m.own && !store.consumed(m.id));
}

export class Bot {
  private readonly batches = new Map<string, Batch>();
  private readonly quarantine = new Map<string, number>();
  // In memory only: a restart re-checks every uncertain action once.
  private readonly rechecks = new Map<string, { tries: number; at: number }>();
  private readonly invitationRetryAt = new Map<string, number>();
  private readonly gaveUp = new Set<string>();
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
    if (action.kind === 'invitation') this.port.noteAcceptance?.();
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
  // The next check of an uncertain action is pushed back further each time.
  private deferRecheck(action: Action): void {
    const tries = (this.rechecks.get(action.id)?.tries ?? 0) + 1;
    this.rechecks.set(action.id, { tries, at: this.now() + recheckDelayMs(action.kind, tries) });
  }
  // The key for the next attempt at an action. A failed attempt that never reached the click
  // left nothing on LinkedIn, so it can be retried under a new key. Any other earlier attempt
  // (confirmed, uncertain, clicked) blocks a new one.
  private nextKey(base: string): { key: string; retries: number } | null {
    for (let retries = 0; ; retries++) {
      const key = retries ? `${base}:retry${retries}` : base;
      const existing = this.store.forKey(key);
      if (!existing) return { key, retries };
      if (existing.status !== 'failed' || existing.handledAt !== null) return null;
    }
  }
  async reconcile(kind: Action['kind']): Promise<void> {
    for (const action of this.store.unresolved().filter(a => a.kind === kind)) {
      this.checkStop();
      // It began executing but never reached the click, so nothing happened on LinkedIn and a
      // retry is safe. This also frees a chat blocked by an earlier version of this check.
      if (action.attempts > 0 && action.handledAt === null) {
        this.store.transition(action, 'failed', this.now());
        this.log.warn({ actionId: action.id, kind },
          'Action never reached the click; marked failed so it can be retried safely');
        continue;
      }
      if ((this.rechecks.get(action.id)?.at ?? 0) > this.now()) continue;
      // After a restart there is no schedule. A reply check only reads the chat, but an
      // invitation check loads a profile page right after startup's own page loads, which
      // LinkedIn answered with HTTP errors. It waits for its first delay instead.
      if (action.kind === 'invitation' && !this.rechecks.has(action.id)) {
        this.deferRecheck(action);
        continue;
      }
      let result: Verification;
      try {
        result = action.kind === 'reply' && action.textHash
          ? await this.port.verifySend(action.ref, action.textHash, action.incomingIds.at(-1)!)
          : await this.port.verifyAcceptance(action.ref);
      } catch (error) {
        if (this.signal.aborted) throw error;
        this.deferRecheck(action);
        this.log.warn({ actionId: action.id, errorType: error instanceof Error ? error.name : 'unknown',
          detail: safeDetail(error) }, 'Reconciliation check failed; will check again later');
        // Systemic: let the worker back off instead of checking the next action.
        if (isHttpRejection(error)) throw error;
        continue;
      }
      this.store.transition(action, result === 'confirmed' ? 'confirmed' : 'uncertain', this.now());
      if (result === 'confirmed') this.logConfirmation(action);
      else {
        this.deferRecheck(action);
        this.log.warn({ actionId: action.id, ref: hash(action.ref) },
          'Outcome uncertain; no resend/re-click. This item remains blocked for manual review');
      }
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
      const next = this.nextKey(`invitation:${inv.id}`);
      if (!next) continue;
      if (!this.live) {
        this.log.info({ ref: hash(inv.id), receivedAt: observed.receipt.at }, 'Dry-run: would accept');
        continue;
      }
      if ((this.invitationRetryAt.get(inv.id) ?? 0) > this.now()) continue;
      if (next.retries >= MAX_PRECLICK_RETRIES) {
        if (!this.gaveUp.has(inv.id)) {
          this.gaveUp.add(inv.id);
          this.log.error({ ref: hash(inv.id), attempts: next.retries },
            'Gave up accepting this invitation after repeated failures before clicking; accept it manually');
        }
        continue;
      }
      if (!this.canAct()) break;
      const action = this.store.create({
        kind: 'invitation', ref: inv.id, key: next.key, incomingIds: [`inv:${inv.id}`], textHash: null,
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
        else {
          this.deferRecheck(action);
          this.log.warn({ actionId: action.id }, 'Acceptance uncertain; will reconcile without clicking again');
        }
      } catch (error) {
        // handledAt is only set right before the click, so null means nothing was clicked.
        const beforeClick = action.handledAt === null;
        this.store.transition(action, beforeClick ? 'failed' : 'uncertain', this.now());
        const errorType = error instanceof Error ? error.name : 'unknown';
        if (beforeClick) {
          this.invitationRetryAt.set(inv.id, this.now() + RETRY_BASE_MS * 2 ** next.retries);
          this.log.error({ actionId: action.id, errorType, detail: safeDetail(error),
            attempt: next.retries + 1, maxAttempts: MAX_PRECLICK_RETRIES },
          'Acceptance failed before clicking Accept; nothing was changed. Will retry after a pause');
        } else {
          this.deferRecheck(action);
          this.log.error({ actionId: action.id, errorType, detail: safeDetail(error) },
            'Acceptance failed or outcome uncertain; paused this invitation');
        }
        if (this.signal.aborted) throw error;
        if (beforeClick && isHttpRejection(error)) throw error;
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
    const next = this.live ? this.nextKey(`reply:${id}:${signature}`) : { key: '', retries: 0 };
    if (!next) { this.batches.delete(id); return; }
    if (next.retries >= MAX_PRECLICK_RETRIES) {
      // Nothing was sent. Stop retrying so the chat is not typed into forever; the owner can answer.
      this.store.consume(incoming.map(m => m.id));
      this.batches.delete(id);
      this.log.error({ ref: hash(id), attempts: next.retries },
        'Gave up replying after repeated failures before sending; reply to this chat manually');
      return;
    }

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
    if (this.config.LOG_CONVERSATION_ONLY) {
      // Compact view for sharing: just the sender's messages and the AI's proposed answer.
      console.log(JSON.stringify({
        incomingMessages: incoming.map(m => (m.text || (m.attachment ? '[attachment]' : '[empty]')).slice(0, 500)),
        aiAnswer: reply.should_reply ? reply.reply : null,
      }));
    } else if (this.config.LOG_MESSAGE_TEXT) {
      // Field names avoid the logger's redaction list ("text", "reply") on purpose.
      this.log.info({
        ref: hash(id), shouldReply: reply.should_reply, language: reply.language, llmMs,
        incomingMessages: incoming.map(m => (m.text || (m.attachment ? '[attachment]' : '[empty]')).slice(0, 500)),
        aiAnswer: reply.should_reply ? reply.reply : null, aiReason: reply.reason,
      }, 'AI answer (LOG_MESSAGE_TEXT is on)');
    }
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
        replyHash: hash(reply.reply) }, this.config.LOG_MESSAGE_TEXT
        ? 'Dry-run: would reply (text shown in the "AI answer" line above)'
        : 'Dry-run: would reply (body not logged; set LOG_MESSAGE_TEXT=true to see it)');
      return;
    }
    if (!this.canAct() || !await this.port.authenticated()) return;
    const first = this.store.observe(incoming[0]!.id, id, incoming[0]!.receipt, this.now());
    const action = this.store.create({
      kind: 'reply', ref: id, key: next.key,
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
      else {
        this.deferRecheck(action);
        this.log.warn({ actionId: action.id }, 'Send uncertain; no automatic retry');
      }
    } catch (error) {
      // handledAt is only set right before the click, so null means nothing was sent.
      const beforeClick = action.handledAt === null;
      this.store.transition(action, beforeClick ? 'failed' : 'uncertain', this.now());
      const errorType = error instanceof Error ? error.name : 'unknown';
      if (beforeClick) {
        this.quarantine.set(id, this.now() + RETRY_BASE_MS * 2 ** next.retries);
        this.log.error({ actionId: action.id, errorType, detail: safeDetail(error),
          attempt: next.retries + 1, maxAttempts: MAX_PRECLICK_RETRIES },
        'Send failed before clicking Send; nothing was sent. Will retry after a pause');
      } else {
        this.deferRecheck(action);
        this.log.error({ actionId: action.id, errorType, detail: safeDetail(error) },
          'Send failed or outcome uncertain; conversation blocked until reconciled');
      }
      this.batches.delete(id);
      if (this.signal.aborted) throw error;
      if (beforeClick && isHttpRejection(error)) throw error;
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

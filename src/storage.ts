import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Action, ActionStatus, Receipt, Timing } from './types.js';

const receiptSchema = z.object({
  at: z.number().nullable(),
  precision: z.enum(['exact', 'minute', 'relative', 'unknown']),
  uncertaintyMs: z.number().nullable(),
});
const actionSchema = z.object({
  id: z.string(), kind: z.enum(['invitation', 'reply']), ref: z.string(), key: z.string(),
  incomingIds: z.array(z.string()), textHash: z.string().nullable(),
  status: z.enum(['pending', 'executing', 'confirmed', 'uncertain', 'failed']),
  receivedAt: z.number().nullable(), lastReceivedAt: z.number().nullable(),
  precision: receiptSchema.shape.precision, uncertaintyMs: z.number().nullable(),
  detectedAt: z.number(), handledAt: z.number().nullable(), confirmedAt: z.number().nullable(),
  generatedAt: z.number().nullable(), llmMs: z.number().nullable(),
  debounceMs: z.number(), attempts: z.number(),
});
const payloadSchema = z.object({ payload: z.string() });
const observationSchema = z.object({
  receipt: z.string(), detected_at: z.number(), consumed: z.number(),
});

export class Store {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, action_key TEXT NOT NULL UNIQUE,
        ref TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, ref TEXT NOT NULL, receipt TEXT NOT NULL,
        detected_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id=1), profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health (
        worker TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, status TEXT NOT NULL
      );
    `);
  }
  bindOwner(profile: string): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO account (id, profile) VALUES (1, ?)').run(profile);
      const row = z.object({ profile: z.string() }).parse(
        this.db.prepare('SELECT profile FROM account WHERE id = 1').get(),
      );
      if (row.profile !== profile) {
        throw new Error('Database belongs to a different account; use a separate DATA_DIR');
      }
    })();
  }
  observe(id: string, ref: string, receipt: Receipt, now: number):
    { receipt: Receipt; detectedAt: number; consumed: boolean } {
    this.db.prepare(`INSERT OR IGNORE INTO observations
      (id, ref, receipt, detected_at) VALUES (?, ?, ?, ?)`)
      .run(id, ref, JSON.stringify(receipt), now);
    const row = observationSchema.parse(
      this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id),
    );
    return { receipt: receiptSchema.parse(JSON.parse(row.receipt)),
      detectedAt: row.detected_at, consumed: row.consumed === 1 };
  }
  consumed(id: string): boolean {
    const row = this.db.prepare('SELECT consumed FROM observations WHERE id = ?').get(id);
    return row !== undefined && z.object({ consumed: z.number() }).parse(row).consumed === 1;
  }
  consume(ids: string[]): void {
    const statement = this.db.prepare('UPDATE observations SET consumed = 1 WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) statement.run(id); })();
  }
  initializeConversation(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO conversations (id) VALUES (?)')
      .run(id).changes === 1;
  }
  create(input: {
    kind: Action['kind']; ref: string; key: string; incomingIds: string[];
    textHash: string | null; timing: Timing; generatedAt?: number;
    llmMs?: number; debounceMs?: number;
  }): Action {
    const action: Action = {
      id: randomUUID(), kind: input.kind, ref: input.ref, key: input.key,
      incomingIds: input.incomingIds, textHash: input.textHash, ...input.timing,
      status: 'pending', handledAt: null, confirmedAt: null,
      generatedAt: input.generatedAt ?? null, llmMs: input.llmMs ?? null,
      debounceMs: input.debounceMs ?? 0, attempts: 0,
    };
    this.db.prepare(`INSERT INTO actions (id, action_key, ref, status, payload)
      VALUES (?, ?, ?, ?, ?)`).run(action.id, action.key, action.ref,
      action.status, JSON.stringify(action));
    return action;
  }
  save(action: Action): void {
    this.db.prepare('UPDATE actions SET status = ?, payload = ? WHERE id = ?')
      .run(action.status, JSON.stringify(action), action.id);
  }
  transition(action: Action, status: ActionStatus, now: number): void {
    action.status = status;
    if (status === 'executing') action.attempts++;
    if (status === 'confirmed') action.confirmedAt = now;
    this.db.transaction(() => {
      this.save(action);
      if (status === 'confirmed') this.consume(action.incomingIds);
    })();
  }
  all(): Action[] {
    return this.db.prepare('SELECT payload FROM actions ORDER BY rowid').all()
      .map(row => actionSchema.parse(JSON.parse(payloadSchema.parse(row).payload)));
  }
  forKey(key: string): Action | undefined {
    const row = this.db.prepare('SELECT payload FROM actions WHERE action_key = ?').get(key);
    return row === undefined ? undefined :
      actionSchema.parse(JSON.parse(payloadSchema.parse(row).payload));
  }
  unresolved(ref?: string): Action[] {
    return this.all().filter(action =>
      ['pending', 'executing', 'uncertain'].includes(action.status) &&
      (ref === undefined || action.ref === ref));
  }
  recentAttempts(now: number): number {
    return this.all().filter(a => a.attempts > 0 &&
      (a.handledAt ?? a.generatedAt ?? a.detectedAt) >= now - 3_600_000).length;
  }
  heartbeat(worker: string, status: string, now: number): void {
    this.db.prepare(`INSERT INTO health VALUES (?, ?, ?) ON CONFLICT(worker)
      DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status`)
      .run(worker, now, status);
  }
  prune(before: number): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE observations SET receipt =
        '{"at":null,"precision":"unknown","uncertaintyMs":null}' WHERE consumed = 1 AND detected_at < ?
        AND ref NOT IN (SELECT ref FROM actions WHERE status IN ('pending','executing','uncertain'))`)
        .run(before);
      // Keep conversation tombstones and action keys to preserve restart deduplication.
      for (const action of this.all()) {
        if (action.status === 'confirmed' && (action.confirmedAt ?? 0) < before) {
          action.incomingIds = [];
          this.save(action);
        }
      }
    })();
  }
  close(): void { this.db.close(); }
}

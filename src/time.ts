import { createHash } from 'node:crypto';
import type { Message, Receipt, Timing } from './types.js';

export const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
export const unknownReceipt = (): Receipt =>
  ({ at: null, precision: 'unknown', uncertaintyMs: null });

export function parseReceipt(raw: string | null, observedAt: number): Receipt {
  if (!raw) return unknownReceipt();
  const value = raw.trim();
  // Only timezone-qualified dates are exact. Locale/time-only labels are ambiguous.
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return { at, precision: 'exact', uncertaintyMs: 0 };
  }
  const relative = /^(\d+)\s*(second|minute|hour|day)s?\s+ago$/i.exec(value);
  if (relative) {
    const units: Record<string, number> = {
      second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000,
    };
    const unit = units[relative[2]!.toLowerCase()]!;
    return { at: observedAt - Number(relative[1]) * unit,
      precision: 'relative', uncertaintyMs: unit };
  }
  return unknownReceipt();
}
export function timing(messages: Message[], detectedAt: number): Timing {
  const first = messages[0];
  const last = messages.at(-1);
  return {
    receivedAt: first?.receipt.at ?? null,
    lastReceivedAt: last?.receipt.at ?? null,
    precision: first?.receipt.precision ?? 'unknown',
    uncertaintyMs: first?.receipt.uncertaintyMs ?? null,
    detectedAt,
  };
}
export function messageId(threadId: string, stableId: string | null, text: string,
  own: boolean, absoluteTime: string | null, occurrence: number): string {
  return stableId ? hash(`${threadId}:id:${stableId}`) :
    hash(JSON.stringify([threadId, own, text, absoluteTime, occurrence]));
}

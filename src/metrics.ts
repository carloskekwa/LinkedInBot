import type { Action } from './types.js';

export function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}
function summarize(values: number[]): Record<string, number | null> {
  return { count: values.length, p50Ms: percentile(values, .5),
    p95Ms: percentile(values, .95), maxMs: percentile(values, 1) };
}
export function report(actions: Action[]): unknown {
  return Object.fromEntries((['invitation', 'reply'] as const).map(kind => {
    const rows = actions.filter(a => a.kind === kind);
    const done = rows.filter(a => a.status === 'confirmed');
    const duration = (from: (a: Action) => number | null,
      to: (a: Action) => number | null, exactOnly = false): number[] =>
      done.flatMap(a => {
        const start = from(a), end = to(a);
        return start !== null && end !== null && end >= start &&
          (!exactOnly || a.precision === 'exact') ? [end - start] : [];
      });
    return [kind, {
      total: rows.length, confirmed: done.length,
      uncertain: rows.filter(a => a.status === 'uncertain').length,
      failed: rows.filter(a => a.status === 'failed').length,
      missingReceipt: rows.filter(a => a.receivedAt === null).length,
      approximateReceipt: rows.filter(a =>
        a.receivedAt !== null && a.precision !== 'exact').length,
      clockSkewSamples: done.filter(a =>
        a.receivedAt !== null && a.receivedAt > a.detectedAt).length,
      receiptToDetectionExact: summarize(duration(a => a.receivedAt, a => a.detectedAt, true)),
      receiptToConfirmationExact: summarize(duration(a => a.receivedAt, a => a.confirmedAt, true)),
      receiptToConfirmationApproximate: summarize(duration(
        a => a.precision !== 'exact' ? a.receivedAt : null, a => a.confirmedAt)),
      detectionToGeneration: summarize(duration(a => a.detectedAt, a => a.generatedAt)),
      detectionToHandling: summarize(duration(a => a.detectedAt, a => a.handledAt)),
      handlingToConfirmation: summarize(duration(a => a.handledAt, a => a.confirmedAt)),
      detectionToConfirmation: summarize(duration(a => a.detectedAt, a => a.confirmedAt)),
      llm: summarize(done.flatMap(a => a.llmMs === null ? [] : [a.llmMs])),
      debounce: summarize(done.map(a => a.debounceMs)),
      retries: rows.reduce((n, a) => n + Math.max(0, a.attempts - 1), 0),
    }];
  }));
}

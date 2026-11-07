// First line only, with URLs and profile/thread paths redacted, so diagnostics stay
// useful (which selector/check failed) without leaking identifiers or message content.
export function safeDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  const firstLine = error.message.split('\n')[0] ?? '';
  return firstLine
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\/(?:in|messaging\/thread|company)\/[^\s"')\]]+/gi, '/<redacted>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(api[_-]?key|token|password|cookie|secret)\b\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '<redacted>')
    .slice(0, 240);
}

// LinkedIn answering page loads with an HTTP error (throttling/blocking) is systemic:
// every further load will likely fail too, and retrying quickly makes it worse.
export function isHttpRejection(error: unknown): boolean {
  return error instanceof Error &&
    /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_TOO_MANY_REDIRECTS/.test(error.message);
}

export function backoffMs(failures: number, httpRejection: boolean): number {
  if (httpRejection) return Math.min(600_000, 120_000 * 2 ** Math.max(0, failures - 1));
  return Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6));
}

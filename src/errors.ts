// First line only, with URLs and profile/thread paths redacted, so diagnostics stay
// useful (which selector/check failed) without leaking identifiers or message content.
export function safeDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error thrown';
  const firstLine = error.message.split('\n')[0] ?? '';
  return firstLine
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\/(?:in|messaging\/thread|company)\/[^\s"')\]]+/gi, '/<redacted>')
    .replace(/(Bearer|api[_-]?key|token|cookie|password)\S*/gi, '<redacted>')
    .slice(0, 240);
}

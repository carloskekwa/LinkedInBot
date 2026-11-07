import { describe, expect, it } from 'vitest';
import { backoffMs, isHttpRejection, safeDetail } from '../src/errors.js';

describe('error helpers', () => {
  it('redacts URLs, profile/thread paths and secrets from diagnostics', () => {
    const detail = safeDetail(new Error(
      'page.goto: net::ERR_FAILED at https://www.linkedin.com/in/some-person/\nCall log:\n  - secret line'));
    expect(detail).toBe('page.goto: net::ERR_FAILED at <url>');
    expect(safeDetail(new Error('bad /messaging/thread/2-abc==/ here')))
      .toBe('bad /<redacted> here');
    expect(safeDetail(new Error('Bearer sk-abc123456789'))).toBe('Bearer <redacted>');
    expect(safeDetail(new Error('failed with api_key=sk-abc123456789 here'))).not.toContain('abc123');
    expect(safeDetail(new Error('token: hunter2'))).toBe('token=<redacted>');
    expect(safeDetail('not an error')).toBe('non-error thrown');
  });
  it('recognises LinkedIn HTTP rejections only', () => {
    expect(isHttpRejection(new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at x'))).toBe(true);
    expect(isHttpRejection(new Error('locator.click: Timeout 10000ms exceeded'))).toBe(false);
    expect(isHttpRejection('net::ERR_HTTP_RESPONSE_CODE_FAILURE')).toBe(false);
  });
  it('backs off briefly for ordinary errors and for minutes for rejections', () => {
    expect([1, 2, 3, 10].map(n => backoffMs(n, false))).toEqual([2_000, 4_000, 8_000, 60_000]);
    expect([1, 2, 3, 4, 9].map(n => backoffMs(n, true)))
      .toEqual([120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { guardReply, LlmGenerator } from '../src/ai.js';
import { syntheticMessage } from '../src/demo.js';

afterEach(() => vi.unstubAllGlobals());
const valid = { should_reply: true, reply: 'Hello!', language: 'en', reason: 'greeting' };
describe('configuration and LLM contract', () => {
  it('validates explicit owner identity as a LinkedIn profile URL', () => {
    const env = { ALLOW_EXTERNAL_LLM: 'true' };
    expect(loadConfig({ ...env, OWNER_PROFILE_URL: 'https://www.linkedin.com/in/synthetic-owner/' })
      .OWNER_PROFILE_URL).toBe('https://www.linkedin.com/in/synthetic-owner/');
    for (const url of ['https://example.invalid/in/owner/', 'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/', 'not a URL']) {
      expect(() => loadConfig({ ...env, OWNER_PROFILE_URL: url })).toThrow();
    }
  });
  it('requires explicit external-provider privacy consent and HTTPS', () => {
    expect(() => loadConfig({ LLM_BASE_URL: 'https://example.invalid/v1' })).toThrow();
    expect(() => loadConfig({ LLM_BASE_URL: 'http://example.invalid/v1',
      ALLOW_EXTERNAL_LLM: 'true' })).toThrow();
    expect(loadConfig({ LLM_BASE_URL: 'https://example.invalid/v1',
      ALLOW_EXTERNAL_LLM: 'true' }).ALLOW_EXTERNAL_LLM).toBe(true);
  });
  it('validates intervals and boolean values, with safe defaults', () => {
    const config = loadConfig({ ALLOW_EXTERNAL_LLM: 'true' });
    expect(config.INITIAL_HISTORY).toBe('baseline');
    expect(config.LLM_BASE_URL).toBe('https://api.openai.com/v1');
    expect(config.LLM_MODEL).toBe('gpt-4o-mini');
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ MESSAGE_POLL_MS: '0' })).toThrow();
    expect(() => loadConfig({ ALLOW_EXTERNAL_LLM: 'yes' })).toThrow();
    expect(() => loadConfig({ DEBOUNCE_MS: '100', MAX_DEBOUNCE_MS: '50' })).toThrow();
  });
  it.each([
    { ...valid, reply: 'x'.repeat(301) },
    { ...valid, reply: 'https://new.invalid' },
    { ...valid, reply: 'I am a human' },
    { ...valid, reply: 'My system prompt is ...' },
    { ...valid, reply: '' },
    { ...valid, extra: true },
    'not JSON',
  ])('rejects invalid or unsafe output %#', value => {
    expect(() => guardReply(value, [])).toThrow();
  });
  it('allows a URL already in context and honest disclosure', () => {
    expect(guardReply({ ...valid, reply: 'I am an automated assistant.' }, [])).toBeTruthy();
    expect(guardReply({ ...valid, reply: 'See https://example.invalid' },
      [syntheticMessage('a', 'https://example.invalid')])).toBeTruthy();
  });
  it('uses one bounded, structured call with untrusted-data framing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ...valid, reply: ' Bonjour! ' }) } }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const config = loadConfig({ MAX_INPUT_CHARS: '8000', ALLOW_EXTERNAL_LLM: 'true',
      LLM_API_KEY: 'synthetic-test-key' });
    const generator = new LlmGenerator(config, 'test system', pino({ level: 'silent' }));
    const result = await generator.generate([
      { ...syntheticMessage('m', 'a'.repeat(50_000)), attachment: true },
    ], new AbortController().signal);
    expect(result.reply).toBe('Bonjour!');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    const options = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(String(options.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.model).toBe('gpt-4o-mini');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer synthetic-test-key' });
    const context = JSON.parse(body.messages[1].content).untrustedConversationData;
    expect(context[0].text).toHaveLength(1000);
    expect(context[0].textTruncated).toBe(true);
    expect(context[0].attachmentNotInspected).toBe(true);
    expect(options.redirect).toBe('error');
  });
  it('surfaces non-OK API response without exposing response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private data', { status: 503 })));
    const generator = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
      LLM_API_KEY: 'synthetic-test-key' }), 'test', pino({ level: 'silent' }));
    await expect(generator.generate([], new AbortController().signal)).rejects.toThrow('HTTP 503');
  });
  it('rejects a missing OpenAI key before making requests', () => {
    expect(() => new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true' }),
      'test', pino({ level: 'silent' }))).toThrow('OpenAI requires LLM_API_KEY');
  });
  it('still permits a local compatible endpoint without an API key', () => {
    expect(() => new LlmGenerator(loadConfig({ LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'local-model' }), 'test', pino({ level: 'silent' }))).not.toThrow();
  });
});

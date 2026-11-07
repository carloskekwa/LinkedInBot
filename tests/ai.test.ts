import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { loadConfig, loadOwnerFacts, loadPrompt } from '../src/config.js';
import { guardReply, LlmGenerator, reviewReply } from '../src/ai.js';
import { syntheticMessage } from '../src/demo.js';

afterEach(() => vi.unstubAllGlobals());
const valid = { should_reply: true, reply: 'Hello!', language: 'en', reason: 'greeting' };
describe('configuration and LLM contract', () => {
  it('loads owner facts, ignoring comments and unfinished <placeholder> lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-test-'));
    try {
      const file = join(dir, 'facts.md');
      writeFileSync(file, [
        '# comment', '', '- I work at Example Corp as an engineer.', '* I am based in Exampleville.',
        '- My name is <first name>.', 'I like synthetic data.',
      ].join('\n'));
      expect(loadOwnerFacts(file)).toEqual({
        facts: ['I work at Example Corp as an engineer.', 'I am based in Exampleville.',
          'I like synthetic data.'], skipped: 1 });
      expect(loadOwnerFacts(join(dir, 'missing.md'))).toEqual({ facts: [], skipped: 0 });
      expect(loadOwnerFacts('')).toEqual({ facts: [], skipped: 0 });
      writeFileSync(file, '- ' + 'x'.repeat(2_100));
      expect(() => loadOwnerFacts(file)).toThrow('too long');
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('appends facts to the prompt only when present, and ships an unfilled example', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-test-'));
    try {
      const base = loadPrompt(loadConfig({ ALLOW_EXTERNAL_LLM: 'true', OWNER_FACTS_FILE: join(dir, 'none.md') }));
      expect(base).not.toContain('FACTS ABOUT THE OWNER (');
      const file = join(dir, 'facts.md');
      writeFileSync(file, '- I work at Example Corp.\n');
      const withFacts = loadPrompt(loadConfig({ ALLOW_EXTERNAL_LLM: 'true', OWNER_FACTS_FILE: file }));
      expect(withFacts.startsWith(base)).toBe(true);
      expect(withFacts).toContain('FACTS ABOUT THE OWNER (approved by the owner');
      expect(withFacts).toContain('- I work at Example Corp.');
      // The committed example is all placeholders, so copying it unedited yields no facts.
      expect(loadOwnerFacts('./prompts/owner-facts.example.md').facts).toEqual([]);
    } finally { rmSync(dir, { recursive: true }); }
  });
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
    expect(body.temperature).toBe(0.8);
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
  describe('one-time rewrite of unusable or rule-breaking drafts', () => {
    const completion = (content: string) => new Response(JSON.stringify({
      choices: [{ message: { content } }] }));
    const draft = (reply: string) => JSON.stringify({ ...valid, reply });
    const generator = () => new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
      LLM_API_KEY: 'synthetic-test-key' }), 'test system', pino({ level: 'silent' }));
    const run = (responses: Response[], incoming = 'hello') => {
      const fetchMock = vi.fn<typeof fetch>();
      for (const response of responses) fetchMock.mockResolvedValueOnce(response);
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, result: () => generator().generate(
        [syntheticMessage('m', incoming)], new AbortController().signal) };
    };

    it('flags commitments and support-bot phrasing, including curly apostrophes', () => {
      for (const text of ['I\u2019d love to hear more.', 'I\'m interested in the role', 'Count me in!',
        'I will definitely join', 'I\u2019ll be there', 'I\'d be interested to hear more',
        'I\'ve been in the industry for about 10 years now.', 'I\'m always interested in hearing about new opportunities!',
        'I\'m always open to hearing about interesting opportunities!', 'Not at the moment, but thanks for asking!',
        'I\'m currently looking for something new.', 'I\'m not looking right now.', 'I would be happy to chat',
        'I\u2019m open to that', 'I\'m happy to help with any questions about React Native!',
        'I\'m happy to chat about my role', 'I\'m glad to meet', 'I\'m excited to connect']) {
        expect(reviewReply(text), text).toMatchObject({ hard: true });
      }
      // Denials, adverbs, profile-content claims and experience claims are all unsupported.
      for (const text of ['I don\'t focus on React Native specifically.', 'I don\'t specifically work with React Native.',
        'React Native isn\'t something I specifically work with.', 'I\'ve got over 10 years of experience in the field.',
        'I have several years of experience in mobile engineering.', 'I have years of experience.',
        'I\'ve been doing this for about 5 years.',
        'It\'s not something I focus on, but you can check my profile.', 'It\u2019s not something I specialize in.',
        'I\'m based in the UK. What about you?', 'I live in NY.',
        'It\'s mentioned on my profile if you want to check it out.', 'It\'s listed in my profile.',
        'I\'ve worked with Kotlin for a while.', 'My role is leading a team.']) {
        expect(reviewReply(text, ['I work at Example Corp as a mobile engineer.']), text).toMatchObject({ hard: true });
      }
      for (const text of ['How can I assist you today?', 'What can I help you with?',
        'Thank you for reaching out!', 'Feel free to ask', 'I\'m here to help with your questions!',
        'I\'ll do my best to help.', 'I understand it can be frustrating.', 'I can\'t share that here.']) {
        expect(reviewReply(text), text).toMatchObject({ hard: false });
      }
      for (const text of ['Hey! What\'s up?', 'Could you share a few details?', '\ud83d\udc4d', 'Anytime!',
        'Sure, go ahead.', 'Thanks! Glad it landed.', 'Not something I can answer properly here.']) {
        expect(reviewReply(text), text).toBeNull();
      }
    });
    it('rejects claims about the owner that the approved facts do not support', () => {
      const none: string[] = [];
      const facts = ['I work at Example Corp as a mobile engineer.', 'I am based in Exampleville.'];
      // Real fabrications observed from the model.
      for (const text of ['I\'m based in London. What about you?',
        'I\'m based in the San Francisco Bay Area. Where are you located?',
        'I don\'t work with React Native, but it\'s a popular choice!',
        'I work at Acme Inc as a designer.', 'I\'m a software architect.',
        'I have 10 years of experience.', 'I specialize in backend systems.',
        'I primarily work as a mobile engineer, but I don\u2019t specialize in React Native.']) {
        expect(reviewReply(text, text.includes('mobile engineer') ? facts : none), text)
          .toMatchObject({ hard: true });
      }
      expect(reviewReply('I work at Example Corp as a mobile engineer, focusing on React Native.', facts))
        .toMatchObject({ hard: true });
    });
    it('accepts claims that match the facts, questions, disclosure and ordinary talk', () => {
      expect(reviewReply('I\'m based in the UK.', ['I am based in the UK.'])).toBeNull();
      expect(reviewReply('I work in NY as a designer.', ['I work in NY as a designer.'])).toBeNull();
      const facts = ['I work at Example Corp as a mobile engineer.', 'I am based in Exampleville.'];
      for (const text of ['I work at Example Corp as a mobile engineer.', 'I\u2019m based in Exampleville. Where are you?',
        'I\'m a mobile engineer at Example Corp.', 'Yes, this is an automated assistant replying on their behalf.',
        'I\'m an automated assistant.', 'I\'m a bit unsure about that one.',
        'It\'s on my profile if you want to take a look.', 'Hey! What\'s up?',
        'Are you focusing on mobile these days?', 'What are you working on right now?',
        'Where are you based?', 'Thanks! Glad it landed.']) {
        expect(reviewReply(text, facts), text).toBeNull();
      }
    });
    it('asks for a rewrite when the first draft invents facts, and uses the compliant one', async () => {
      const { fetchMock, result } = run([
        completion(draft('I\'m based in London. What about you?')),
        completion(draft('It\'s on my profile if you want to take a look.')),
      ], 'Where are you based?');
      expect((await result()).reply).toBe('It\'s on my profile if you want to take a look.');
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(retryBody.messages[0].content).toContain('not in the approved facts');
    });
    it.each(['are you a bot ?', 'Are you a bot?', 'r u a bot', 'Are you real?', 'is this an AI?',
      'Am I talking to a human?', 'are you actually a person?', 'Is this really you?'])(
      'answers "%s" honestly without a model call', async question => {
        const { fetchMock, result } = run([], question);
        const reply = await result();
        expect(reply.reply).toContain('automated assistant');
        expect(fetchMock).not.toHaveBeenCalled();
      });
    it('does not treat ordinary questions as automation questions', async () => {
      const { fetchMock, result } = run([completion(draft('Sure, go ahead.'))], 'are you available for a quick question?');
      expect((await result()).reply).toBe('Sure, go ahead.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('flags any draft that denies being automated or claims to be a person', () => {
      for (const text of ['No, I\'m not a bot!', 'I\'m a real person.', 'I am human.', 'Nope, not a bot.',
        'This is not automated.', 'I\u2019m definitely not an AI.', 'No, I\'m a real person, promise.']) {
        expect(reviewReply(text), text).toMatchObject({ hard: true, rule: 'automation-denial' });
      }
      expect(reviewReply('Yes, this is an automated assistant replying on their behalf.')).toBeNull();
    });
    it('never lets a model denial through when the question is longer than the plain form', async () => {
      const { result } = run([completion(draft('No, I\'m not a bot, just a real person!')),
        completion(draft('Nope, I\'m a real person.'))],
      'Hi there, quick one before we continue: are you a bot, or am I talking to you?');
      const reply = await result();
      expect(reply.reply).toContain('automated assistant');
      expect(reply.reply).not.toMatch(/real person|not a bot/i);
    });
    it('does not send a disclosure line for an unprompted denial', async () => {
      const { result } = run([completion(draft('I\'m a real person.')), completion(draft('I\'m a real person.'))],
        'what do you think of the new release?');
      await expect(result()).rejects.toThrow();
    });
    it('rejects denials of experience in every phrasing, even when facts are listed', () => {
      const facts = ['I work as a mobile engineer using Swift, Java and Spring Boot.'];
      for (const text of ['I don\'t have experience with Golang specifically.', 'I haven\'t used Go.',
        'I\'ve never worked with Go.', 'I\'m not familiar with Go.', 'I have no experience with Go.',
        'I have little experience with Go.', 'I don\u2019t know Go.', 'I haven\'t touched Rust.',
        'I do not have any experience with Kotlin.', 'I\'m not experienced in Go.',
        'I don\'t have experience with Golang specifically, but I focus more on mobile development.']) {
        expect(reviewReply(text, facts), text).toMatchObject({ hard: true, rule: 'owner-claim' });
      }
      for (const text of ['I don\'t know what you mean.', 'I can\'t open links from here.',
        'I haven\'t seen the attachment.', 'My main stack is Swift and Java on the backend.']) {
        expect(reviewReply(text, facts), text).toBeNull();
      }
    });
    it('treats the stock "What about you?" follow-up as a soft style issue', () => {
      for (const text of ['Nice to meet you! What about you?', 'Good, and you?', 'How about yourself?']) {
        expect(reviewReply(text), text).toMatchObject({ hard: false, rule: 'support-bot-style' });
      }
      expect(reviewReply('Sure. What are you working on?')).toBeNull();
    });
    it('rewrites the reported Golang denial into a neutral stack answer', async () => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(completion(draft('I don\'t have experience with Golang specifically, but I focus ' +
          'more on mobile development and Java. What about you?')))
        .mockResolvedValueOnce(completion(draft('My main stack is mobile and Java. What are you working on?')));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key' }), 'test system', pino({ level: 'silent' }),
        ['I work on mobile development and Java backends.']);
      const reply = await withFacts.generate([syntheticMessage('m', 'do u know golang techstack?')],
        new AbortController().signal);
      expect(reply.reply).toBe('My main stack is mobile and Java. What are you working on?');
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(retryBody.messages[0].content).toContain('denied having experience');
    });
    it('never states openness from the facts: opportunity questions get a request for details', async () => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(completion(draft('I\'m open to interesting opportunities. What did you have in mind?')))
        .mockResolvedValueOnce(completion(draft('I\'m also open to technical collaborations.')));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key' }), 'test system', pino({ level: 'silent' }),
        ['I\'m also open to interesting technical collaborations and consulting opportunities.']);
      const reply = await withFacts.generate([syntheticMessage('m', 'Are you open to new opportunities?')],
        new AbortController().signal);
      expect(reply.reply).toBe('Could you share a few more details?');
    });
    it('rejects persistent owner claims instead of substituting an unrelated profile referral', async () => {
      const { result } = run([completion(draft('I\'m based in London.')),
        completion(draft('I live in Paris.'))], 'What did you think of that post?');
      await expect(result()).rejects.toThrow('unsupported claim');
    });
    it.each([
      ['hi', 'I\'m based in London.', 'I live in Paris.'],
      [' hello! ', 'I\'m interested!', 'Count me in!'],
      ['HEY', 'I live in London.', 'It\'s on my profile if you want to take a look.'],
      ['good morning', 'It\'s on my profile.', 'It\'s on my profile.'],
    ])('uses a greeting after two rejected drafts for %s', async (incoming, first, second) => {
      const { fetchMock, result } = run([completion(draft(first)), completion(draft(second))], incoming);
      const reply = await result();
      expect(reply.reply).toBe('Hey!');
      expect(reply.reason).toContain('neutral substitute');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(retryBody.messages[0].content).toContain('Answer only the latest incoming message');
    });
    it.each([
      ['hi', 'Hey! Not much, just keeping busy. How about you?'],
      ['hi', 'Hey! I\'m doing great, thanks.'],
      ['how are you doing today?', 'Doing well, just a busy day. You?'],
    ])('rejects an invented owner state or activity in reply to %s', async (incoming, invented) => {
      const { fetchMock, result } = run([completion(draft(invented)), completion(draft('Hey!'))], incoming);
      expect((await result()).reply).toBe('Hey!');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(retryBody.messages[0].content).toContain('invented state');
    });
    it('falls back to a plain greeting when the rewrite still invents an activity', async () => {
      const { result } = run([completion(draft('Hey! Not much, just keeping busy.')),
        completion(draft('Hey! All good here.'))], 'hi');
      expect((await result()).reply).toBe('Hey!');
    });
    it('does not apply the small-talk state check to substantive messages', async () => {
      const { fetchMock, result } = run([completion(draft('Sounds busy! What did you want to go over?'))],
        'quick question about your team');
      expect((await result()).reply).toContain('busy');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('rejects even supported owner facts when the latest message is just a greeting', async () => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(completion(draft('I\'m based in Exampleville.')))
        .mockResolvedValueOnce(completion(draft('Hey!')));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key' }), 'test system', pino({ level: 'silent' }),
        ['I am based in Exampleville.']);
      const reply = await withFacts.generate([
        syntheticMessage('old', 'Where are you based?'),
        { ...syntheticMessage('owner', 'I am based in Exampleville.'), own: true },
        syntheticMessage('new', 'hi'),
      ], new AbortController().signal);
      expect(reply.reply).toBe('Hey!');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it.each([
      ['how are you doing today?', 'All good! How\'s your day going?'],
      ['Hey, how are you?', 'All good! How\'s your day going?'],
      ['How\u2019s your day going?', 'All good! How\'s your day going?'],
      ['thanks!', 'Anytime!'],
      ['ok', 'Got it.'],
      ['bye', 'Take care!'],
    ])('blocks approved but irrelevant work facts for %s', async (incoming, expected) => {
      const lines: string[] = [];
      const logger = pino({ level: 'debug' }, { write: line => { lines.push(line); } });
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(completion(draft('I work at Example Corp as a mobile engineer. What about you?')))
        .mockResolvedValueOnce(completion(draft('It\'s on my profile if you want more details.')));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key' }), 'test system', logger,
        ['I work at Example Corp as a mobile engineer.']);
      const reply = await withFacts.generate([
        syntheticMessage('old', 'Where do you work?'),
        { ...syntheticMessage('owner', 'I work at Example Corp as a mobile engineer.'), own: true },
        syntheticMessage('new', incoming),
      ], new AbortController().signal);
      expect(reply.reply).toBe(expected);
      expect(lines.join('')).toContain('"rule":"smalltalk-context"');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        const body = JSON.parse(String(call[1]!.body));
        const data = JSON.parse(body.messages[1].content);
        expect(data.latestIncomingMessage).toEqual({
          sender: 'incoming', text: incoming, textTruncated: false, attachmentNotInspected: false,
        });
        expect(data.untrustedConversationData[0].text).toBe('Where do you work?');
        expect(body.messages[0].content).toContain('ordered oldest to newest');
      }
    });
    it('uses a natural rewrite for the reported wellbeing question', async () => {
      const { fetchMock, result } = run([
        completion(draft('I live in London.')),
        completion(draft('All good! How\'s your day going?')),
      ], 'how are you doing today?');
      expect((await result()).reply).toBe('All good! How\'s your day going?');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('accepts the exact owner-approved wellbeing greeting without a rewrite', async () => {
      const { fetchMock, result } = run([completion(draft('All good! How\'s your day going?'))],
        'how are you doing ?');
      expect((await result()).reply).toBe('All good! How\'s your day going?');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it.each([
      ['Where do you work?', 'I work at Example Corp. What about you?', 'I work at Example Corp.'],
      ['where are you located', 'I\'m based in Exampleville. Where are you based?', 'I\'m based in Exampleville.'],
      ['What is your role?', 'I\'m an engineer. What are you working on?', 'I\'m an engineer.'],
    ])('answers %s without asking the sender a question', async (incoming, draftText, expected) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion(draft(draftText)));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key' }), 'test system', pino({ level: 'silent' }),
        ['I work at Example Corp.', 'I am based in Exampleville.', 'I am an engineer.']);
      expect((await withFacts.generate([syntheticMessage('m', incoming)],
        new AbortController().signal)).reply).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('still rejects unsupported facts after removing a reciprocal question', async () => {
      const { result } = run([completion(draft('I work at Unlisted Corp. What about you?')),
        completion(draft('I work at Another Corp. Where do you work?'))], 'Where do you work?');
      await expect(result()).rejects.toThrow('unsupported claim');
    });
    it('keeps necessary opportunity clarification questions', async () => {
      const { result } = run([completion(draft('Could you share a few details about the role?'))],
        'Are you open to new opportunities?');
      expect((await result()).reply).toBe('Could you share a few details about the role?');
    });
    it('does not allow the wellbeing exception for hi or added personal activities', async () => {
      for (const [incoming, answer] of [
        ['hi', 'All good! How\'s your day going?'],
        ['how are you?', 'All good! Just keeping busy. How\'s your day going?'],
      ] as const) {
        const { fetchMock, result } = run([completion(draft(answer)), completion(draft('Hey!'))], incoming);
        expect((await result()).reply).toBe('Hey!');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    });
    it.each(['how are you doing today? Where do you work?', 'thanks, can we meet tomorrow?'])(
      'does not classify a mixed substantive message as small talk: %s', async incoming => {
        const { result } = run([completion(draft('I live in London.')),
          completion(draft('I live in Paris.'))], incoming);
        await expect(result()).rejects.toThrow('unsupported claim');
      });
    it.each(['hi, where do you work?', 'Please stop messaging me.'])(
      'does not turn %s into a greeting after persistent owner claims', async incoming => {
        const { result } = run([completion(draft('I live in London.')),
          completion(draft('I live in Paris.'))], incoming);
        await expect(result()).rejects.toThrow('unsupported claim');
      });
    it('does not use a greeting substitute for an attachment or an owner-authored last message', async () => {
      for (const extra of [{ attachment: true }, { own: true }]) {
        const { fetchMock } = run([completion(draft('I live in London.')),
          completion(draft('I live in Paris.'))]);
        await expect(generator().generate([{ ...syntheticMessage('m', 'hi'), ...extra }],
          new AbortController().signal)).rejects.toThrow('unsupported claim');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    });
    it.each(['false', 'true'])('logs rejection rules, with draft text opt-in=%s', async enabled => {
      const lines: string[] = [];
      const logger = pino({ level: 'debug' }, { write: line => { lines.push(line); } });
      const { fetchMock } = run([completion(draft('I live in London.')),
        completion(draft('I live in Paris.'))]);
      const logged = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true',
        LLM_API_KEY: 'synthetic-test-key', LOG_MESSAGE_TEXT: enabled }), 'test system', logger);
      expect((await logged.generate([syntheticMessage('m', 'hi')],
        new AbortController().signal)).reply).toBe('Hey!');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const output = lines.join('');
      expect(output).toContain('"rule":"owner-claim"');
      if (enabled === 'true') {
        expect(output).toContain('"aiDraft":"I live in London."');
        expect(output).toContain('"aiDraft":"I live in Paris."');
        expect(output).toContain('"attempt":2');
      } else {
        expect(output).not.toContain('aiDraft');
        expect(output).not.toContain('London');
        expect(output).not.toContain('Paris');
      }
    });
    it('uses the generic fallback (throws) when a persistent violation is not in English', async () => {
      const fr = (reply: string) => completion(JSON.stringify({ ...valid, language: 'fr', reply }));
      const { result } = run([fr('I\'m based in London.'), fr('I live in Paris.')]);
      await expect(result()).rejects.toThrow('unsupported claim');
    });
    it('uses the owner facts passed to the generator', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        completion(draft('I\'m based in Exampleville.')));
      vi.stubGlobal('fetch', fetchMock);
      const withFacts = new LlmGenerator(loadConfig({ ALLOW_EXTERNAL_LLM: 'true', LLM_API_KEY: 'synthetic-test-key' }),
        'test system', pino({ level: 'silent' }), ['I am based in Exampleville.']);
      expect((await withFacts.generate([syntheticMessage('m', 'where are you based?')],
        new AbortController().signal)).reply).toBe('I\'m based in Exampleville.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('asks for exactly one rewrite and uses it', async () => {
      const { fetchMock, result } = run([
        completion(draft('I\u2019d love to hear more about it.')),
        completion(draft('Could you share a few details?')),
      ]);
      expect((await result()).reply).toBe('Could you share a few details?');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
      expect(retryBody.messages[0].content).toContain('previous draft was rejected');
      expect(retryBody.messages[0].content).toContain('commitment');
    });
    it('does not retry a clean draft', async () => {
      const { fetchMock, result } = run([completion(draft('Hey! What\'s up?'))]);
      await result();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('tolerates a style-only issue on the final attempt but never a commitment', async () => {
      const soft = run([completion(draft('How can I help you?')), completion(draft('What can I help you with?'))]);
      expect((await soft.result()).reply).toBe('What can I help you with?');
      expect(soft.fetchMock).toHaveBeenCalledTimes(2);
      const hard = run([completion(draft('I\'m interested!')), completion(draft('Count me in!'))],
        'Can we have a call tomorrow?');
      const substituted = await hard.result();
      expect(substituted.reply).toBe('Could you share a few more details?');
      expect(hard.fetchMock).toHaveBeenCalledTimes(2);
    });
    it('recovers once from invalid JSON, then gives up', async () => {
      const recovered = run([completion('not json'), completion(draft('Hey!'))]);
      expect((await recovered.result()).reply).toBe('Hey!');
      const failing = run([completion('not json'), completion('still not json')]);
      await expect(failing.result()).rejects.toThrow();
      expect(failing.fetchMock).toHaveBeenCalledTimes(2);
    });
    it('does not retry transport failures, so outages stay fast', async () => {
      const { fetchMock, result } = run([new Response('x', { status: 503 })]);
      await expect(result()).rejects.toThrow('HTTP 503');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('does not retry after the caller aborted', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(completion('not json'));
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const promise = generator().generate([syntheticMessage('m', 'hello')], controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow();
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
    });
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

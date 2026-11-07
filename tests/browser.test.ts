import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pino } from 'pino';
import { PlaywrightAdapter, profileUrl } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { hash } from '../src/time.js';

let browser: Browser;
const fixture = `
  <nav class="global-nav">
    <a href="/in/synthetic-owner/">Me</a>
  </nav>
  <div class="invitation-manager">
    <div class="invitation-card">
      <a href="/in/synthetic-contact/">Synthetic contact</a>
      <time datetime="2026-11-07T14:00:00Z"></time>
      <button aria-label="Accept Synthetic contact" onclick="this.parentElement.remove()">Accept</button>
    </div>
  </div>
  <button aria-label="More actions" onclick="document.querySelector('[role=menuitem]').hidden=false">More</button>
  <div role="menuitem" hidden>Remove connection</div>
  <div class="msg-conversations-container">
    <a href="/messaging/thread/synthetic/">Synthetic thread</a>
  </div>
  <a class="msg-thread__link-to-profile" href="/in/synthetic-contact/">Synthetic contact</a>
  <ul class="msg-s-message-list">
    <li class="msg-s-message-list__event" data-event-urn="urn:synthetic:incoming">
      <a class="msg-s-message-group__profile-link" href="/in/synthetic-contact/">Sender</a>
      <p class="msg-s-event-listitem__body">Hello!</p>
      <time datetime="2026-11-07T14:01:00Z"></time>
    </li>
  </ul>
  <div class="msg-form__contenteditable" contenteditable="true"></div>
  <button class="msg-form__send-button" onclick="sendSynthetic()">Send</button>
  <script>
    function sendSynthetic() {
      const composer = document.querySelector('[contenteditable]');
      const message = document.createElement('li');
      message.className = 'msg-s-message-list__event msg-s-message-list__event--own';
      message.setAttribute('data-event-urn', 'urn:synthetic:own');
      const body = document.createElement('p');
      body.className = 'msg-s-event-listitem__body';
      body.textContent = composer.textContent;
      message.append(body);
      document.querySelector('ul').append(message);
      composer.textContent = '';
    }
  </script>
`;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { if (browser) await browser.close(); });
async function adapter() {
  const context = await browser.newContext();
  // All requests are fulfilled locally; no LinkedIn/network access in this suite.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const invitations = await context.newPage();
  const messages = await context.newPage();
  await messages.goto('https://www.linkedin.com/feed/');
  const port = new PlaywrightAdapter(context, invitations, messages,
    loadConfig({ ALLOW_EXTERNAL_LLM: 'true' }), pino({ level: 'silent' }));
  await port.initialize();
  return { port, invitations, messages };
}
describe('live adapter against synthetic DOM (not live LinkedIn)', () => {
  it('finishes login on navigation without legacy LinkedIn classes', async () => {
    const { port, messages, invitations } = await adapter();
    try {
      const modern = '<nav><a href="/feed/">Home</a><a href="/messaging/">Messaging</a></nav>';
      await messages.setContent(modern);
      await invitations.setContent(modern);
      await port.login(AbortSignal.timeout(2000));
      expect(await port.authenticated()).toBe(true);
      await messages.goto('https://www.linkedin.com/checkpoint/');
      expect(await port.authenticated()).toBe(false);
    } finally { await port.close(); }
  });
  it('does not accept generic or hidden navigation as proof of login', async () => {
    const { port, messages, invitations } = await adapter();
    try {
      const hidden = '<nav>Public links</nav><nav hidden><a href="/feed/">Home</a><a href="/messaging/">Messaging</a></nav>';
      await messages.setContent(hidden);
      await invitations.setContent(hidden);
      expect(await port.authenticated()).toBe(false);
    } finally { await port.close(); }
  });
  it('restricts profile navigation to LinkedIn profile paths', () => {
    expect(profileUrl('/in/synthetic/?tracking=1')).toBe('https://www.linkedin.com/in/synthetic/');
    expect(() => profileUrl('https://example.invalid/in/synthetic/')).toThrow();
  });
  it('reads invitations, receipt timestamps and connection-state confirmation', async () => {
    const { port } = await adapter();
    try {
      const invitations = await port.invitations();
      expect(invitations).toHaveLength(1);
      expect(invitations[0]?.receipt.precision).toBe('exact');
      let clicked = false;
      await port.accept(invitations[0]!.id, () => { clicked = true; });
      expect(clicked).toBe(true);
      expect(await port.verifyAcceptance(invitations[0]!.id)).toBe('confirmed');
    } finally { await port.close(); }
  });
  it('classifies incoming/own messages and verifies a new send after the inbound anchor', async () => {
    const { port } = await adapter();
    try {
      const ids = await port.conversations();
      expect(ids).toHaveLength(1);
      const thread = await port.thread(ids[0]!);
      expect(thread.supported).toBe(true);
      expect(thread.messages[0]?.own).toBe(false);
      let clicked = false;
      await port.send(ids[0]!, 'Synthetic reply', () => { clicked = true; });
      expect(clicked).toBe(true);
      expect(await port.verifySend(ids[0]!, hash('Synthetic reply'), thread.messages[0]!.id))
        .toBe('confirmed');
    } finally { await port.close(); }
  });
  it('does not overwrite or send an existing owner draft', async () => {
    const { port, messages } = await adapter();
    try {
      const id = (await port.conversations())[0]!;
      await port.thread(id);
      await messages.locator('[contenteditable]').fill('Owner draft');
      await expect(port.send(id, 'Bot reply', () => {})).rejects.toThrow('Existing composer draft');
      expect(await messages.locator('[contenteditable]').innerText()).toBe('Owner draft');
    } finally { await port.close(); }
  });
  it('clears only its own draft if Stop occurs before Send', async () => {
    const { port, messages } = await adapter();
    try {
      const id = (await port.conversations())[0]!;
      await port.thread(id);
      await expect(port.send(id, 'Bot reply', () => { throw new Error('Stopped'); }))
        .rejects.toThrow('Stopped');
      expect((await messages.locator('[contenteditable]').innerText()).trim()).toBe('');
    } finally { await port.close(); }
  });
  it('cannot confirm an invitation merely because its card disappeared', async () => {
    const { port, invitations } = await adapter();
    try {
      await invitations.route('**/in/**', route => route.fulfill({
        contentType: 'text/html', body: '<nav class="global-nav"></nav><p>Not connected</p>',
      }));
      expect(await port.verifyAcceptance('https://www.linkedin.com/in/synthetic-contact/'))
        .toBe('uncertain');
    } finally { await port.close(); }
  });
});

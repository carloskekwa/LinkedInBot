import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pino } from 'pino';
import { PlaywrightAdapter, profileUrl } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { hash } from '../src/time.js';

let browser: Browser;
// Mirrors the LinkedIn DOM observed via "npm run inspect:live" (Nov 2026): obfuscated
// invitation classes with role/aria-label, link-less conversation cards, data-event-urn
// message events with an "--other" marker, and a Send button rendered only after typing.
const fixture = `
  <nav class="global-nav">
    <a href="/in/synthetic-owner/">Me</a>
    <a href="/messaging/">Messaging</a>
  </nav>
  <main>
    <div role="list">
      <div role="listitem">
        <a href="/in/synthetic-contact/">Synthetic contact</a>
        <span>2 hours ago</span>
        <button aria-label="Ignore Synthetic contact's invitation">Ignore</button>
        <button aria-label="Accept Synthetic contact's invitation" onclick="this.parentElement.remove()">Accept</button>
      </div>
      <div role="listitem">
        <a href="/in/synthetic-inviter/">Inviter</a>
        <button aria-label="Accept Synthetic Page invitation for Inviter Name">Accept</button>
      </div>
      <div role="listitem">
        <button aria-label="Accept invitation for Synthetic Newsletter">Accept</button>
      </div>
      <div role="listitem">
        <a href="/company/synthetic-co/">Company</a>
        <button aria-label="Accept Synthetic Co invitation">Accept</button>
      </div>
    </div>
  </main>
  <button aria-label="More actions" onclick="document.querySelector('[role=menuitem]').hidden=false">More</button>
  <div role="menuitem" hidden>Remove connection</div>
  <ul class="msg-conversations-container__conversations-list">
    <li class="msg-conversation-listitem">
      <div class="msg-conversation-listitem__link" onclick="history.pushState({}, '', '/messaging/thread/synthetic-1/')">
        <span class="msg-conversation-listitem__active-text">Active</span>
        <h3 class="msg-conversation-listitem__participant-names">Synthetic contact</h3>
        <p class="msg-conversation-card__message-snippet">Hello!</p>
        <time class="msg-conversation-card__time-stamp">10:00 AM</time>
      </div>
    </li>
    <li class="msg-conversation-listitem">
      <div class="msg-conversation-listitem__link" onclick="history.pushState({}, '', '/messaging/thread/synthetic-2/')">
        <h3 class="msg-conversation-listitem__participant-names">Second contact</h3>
        <p class="msg-conversation-card__message-snippet">Hi</p>
        <time class="msg-conversation-card__time-stamp">Nov 3</time>
      </div>
    </li>
    <li class="msg-conversation-listitem">
      <div class="msg-conversation-listitem__link">
        <img data-js-sponsored-conversation-hoverable-trigger>
        <h3 class="msg-conversation-listitem__participant-names">Sponsored sender</h3>
      </div>
    </li>
  </ul>
  <a class="msg-thread__link-to-profile" href="/in/synthetic-contact/">Synthetic contact</a>
  <ul class="msg-s-message-list-content">
    <li class="msg-s-message-list__event">
      <time class="msg-s-message-list__time-heading">Today</time>
      <div class="msg-s-event-listitem msg-s-event-listitem--other" data-event-urn="urn:synthetic:incoming">
        <a class="msg-s-event-listitem__link" href="/in/synthetic-contact/"><img></a>
        <div class="msg-s-message-group__meta">
          <button class="msg-s-message-group__profile-link">Synthetic contact</button>
          <time class="msg-s-message-group__timestamp">10:00 AM</time>
        </div>
        <p class="msg-s-event-listitem__body">Hello!</p>
      </div>
    </li>
  </ul>
  <form class="msg-form">
    <div class="msg-form__contenteditable" role="textbox" contenteditable="true" oninput="toggleSend()"></div>
    <button type="button" class="msg-form__send-toggle">Mode</button>
  </form>
  <script>
    function toggleSend() {
      const form = document.querySelector('form.msg-form');
      const existing = form.querySelector('.msg-form__send-button');
      const hasText = document.querySelector('[contenteditable]').textContent.trim().length > 0;
      if (hasText && !existing) {
        const button = document.createElement('button');
        button.type = 'submit'; button.className = 'msg-form__send-button'; button.textContent = 'Send';
        button.onclick = (e) => { e.preventDefault(); sendSynthetic(); };
        form.append(button);
      } else if (!hasText && existing) existing.remove();
    }
    function sendSynthetic() {
      const composer = document.querySelector('[contenteditable]');
      const li = document.createElement('li');
      li.className = 'msg-s-message-list__event';
      const event = document.createElement('div');
      event.className = 'msg-s-event-listitem msg-s-event-listitem--last-in-group';
      event.setAttribute('data-event-urn', 'urn:synthetic:own');
      event.innerHTML = '<a class="msg-s-event-listitem__link" href="/in/synthetic-owner/"></a>';
      const body = document.createElement('p');
      body.className = 'msg-s-event-listitem__body';
      body.textContent = composer.textContent;
      event.append(body); li.append(event);
      document.querySelector('ul.msg-s-message-list-content').append(li);
      composer.textContent = '';
      toggleSend();
    }
  </script>
`;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { if (browser) await browser.close(); });
async function adapter(ownerUrl = '', html = fixture) {
  const context = await browser.newContext();
  // All requests are fulfilled locally; no LinkedIn/network access in this suite.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const invitations = await context.newPage();
  const messages = await context.newPage();
  await messages.goto('https://www.linkedin.com/feed/');
  const port = new PlaywrightAdapter(context, invitations, messages,
    loadConfig({ ALLOW_EXTERNAL_LLM: 'true', OWNER_PROFILE_URL: ownerUrl }), pino({ level: 'silent' }));
  try { await port.initialize(); }
  catch (error) { await port.close(); throw error; }
  return { port, invitations, messages };
}
describe('live adapter against synthetic DOM (not live LinkedIn)', { timeout: 20_000 }, () => {
  it('uses configured owner when the legacy owner menu is absent', async () => {
    const html = fixture.replace('<a href="/in/synthetic-owner/">Me</a>', '');
    const { port } = await adapter('https://www.linkedin.com/in/synthetic-owner/?tracking=1', html);
    try {
      expect(port.ownerIdentity()).toBe('https://www.linkedin.com/in/synthetic-owner/');
    } finally { await port.close(); }
  });
  it('reports an actionable owner setting error instead of waiting for a missing menu', async () => {
    const html = fixture.replace('<a href="/in/synthetic-owner/">Me</a>', '');
    await expect(adapter('', html)).rejects.toThrow('Set OWNER_PROFILE_URL');
  });
  it('finishes login on navigation without legacy LinkedIn classes', async () => {
    const { port, messages, invitations } = await adapter();
    try {
      const modern = '<nav><a href="/messaging/">Messaging</a></nav><nav>Other links</nav>';
      await messages.setContent(modern);
      await invitations.setContent(modern);
      await port.login(AbortSignal.timeout(2000));
      expect(await port.authenticated()).toBe(true);
      await messages.goto('https://www.linkedin.com/checkpoint/');
      expect(await port.authenticated()).toBe(false);
      await messages.goto('https://www.linkedin.com/login');
      await invitations.goto('https://www.linkedin.com/login');
      await messages.setContent(modern);
      await invitations.setContent(modern);
      expect(await port.authenticated()).toBe(false);
    } finally { await port.close(); }
  });
  it('does not accept generic or hidden navigation as proof of login', async () => {
    const { port, messages, invitations } = await adapter();
    try {
      const hidden = '<nav>Public links</nav><nav hidden><a href="/messaging/">Messaging</a></nav>';
      await messages.setContent(hidden);
      await invitations.setContent(hidden);
      expect(await port.authenticated()).toBe(false);
    } finally { await port.close(); }
  });
  it('restricts profile navigation to LinkedIn profile paths', () => {
    expect(profileUrl('/in/synthetic/?tracking=1')).toBe('https://www.linkedin.com/in/synthetic/');
    expect(() => profileUrl('https://example.invalid/in/synthetic/')).toThrow();
  });
  it('accepts only person connection requests, not Page or newsletter invitations', async () => {
    const { port } = await adapter();
    try {
      const invitations = await port.invitations();
      expect(invitations).toHaveLength(1);
      expect(invitations[0]?.id).toBe('https://www.linkedin.com/in/synthetic-contact/');
      expect(invitations[0]?.receipt.precision).toBe('relative');
      let clicked = false;
      await port.accept(invitations[0]!.id, () => { clicked = true; });
      expect(clicked).toBe(true);
      expect(await port.verifyAcceptance(invitations[0]!.id)).toBe('confirmed');
    } finally { await port.close(); }
  });
  it('discovers link-less conversation cards by clicking once, then reports only changes', async () => {
    const { port, messages } = await adapter();
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      const first = await port.conversations();
      expect(first.sort()).toEqual([
        'https://www.linkedin.com/messaging/thread/synthetic-1/',
        'https://www.linkedin.com/messaging/thread/synthetic-2/',
      ]);
      // Simulate time passing beyond the change window: nothing changed, nothing reported.
      await messages.evaluate(() => {
        document.querySelector('.msg-conversation-card__message-snippet')!.textContent = 'New message';
      });
      const second = await port.conversations();
      expect(second).toContain('https://www.linkedin.com/messaging/thread/synthetic-1/');
    } finally { await port.close(); }
  });
  it('classifies incoming/own messages and verifies a new send after the inbound anchor', async () => {
    const { port, messages } = await adapter();
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      const ids = await port.conversations();
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      expect(ids).toContain(id);
      const thread = await port.thread(id);
      expect(thread.supported).toBe(true);
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages[0]?.own).toBe(false);
      expect(thread.messages[0]?.receipt.precision).toBe('unknown');
      let clicked = false;
      await port.send(id, 'Synthetic reply', () => { clicked = true; });
      expect(clicked).toBe(true);
      expect(await port.verifySend(id, hash('Synthetic reply'), thread.messages[0]!.id))
        .toBe('confirmed');
      const after = await port.thread(id);
      expect(after.messages.map(m => m.own)).toEqual([false, true]);
    } finally { await port.close(); }
  });
  it('classifies a non-recipient linked sender as the owner in a one-to-one thread', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.evaluate(() => {
        const event = document.querySelector('.msg-s-event-listitem')!;
        event.classList.remove('msg-s-event-listitem--other');
        event.querySelector('a')!.setAttribute('href', '/in/ACoAAownerMemberId/');
      });
      const thread = await port.thread(id);
      expect(thread.messages[0]?.own).toBe(true);
      // The learned alias must never be accepted as incoming later.
      await messages.evaluate(() => {
        document.querySelector('.msg-s-event-listitem')!.classList.add('msg-s-event-listitem--other');
      });
      await expect(port.thread(id)).rejects.toThrow('owner alias contradicted');
    } finally { await port.close(); }
  });
  it('marks threads whose recipient is a Page/organisation as unsupported', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.evaluate(() => {
        document.querySelector('.msg-thread__link-to-profile')!.setAttribute('href', '/company/synthetic-co/');
      });
      expect((await port.thread(id)).supported).toBe(false);
    } finally { await port.close(); }
  });
  it('refuses to classify a message without any sender link or marker', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.evaluate(() => {
        const event = document.querySelector('.msg-s-event-listitem')!;
        event.classList.remove('msg-s-event-listitem--other');
        event.querySelector('a')!.remove();
      });
      await expect(port.thread(id)).rejects.toThrow('cannot be classified');
    } finally { await port.close(); }
  });
  it('aborts safely when no Send button appears after typing', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.evaluate(() => {
        document.querySelector('[contenteditable]')!.removeAttribute('oninput');
      });
      await expect(port.send(id, 'Bot reply', () => { throw new Error('must not dispatch'); }))
        .rejects.toThrow(/Timeout|waitFor/);
      expect((await messages.locator('[contenteditable]').innerText()).trim()).toBe('');
    } finally { await port.close(); }
  });
  it('does not overwrite or send an existing owner draft', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.locator('[contenteditable]').fill('Owner draft');
      await expect(port.send(id, 'Bot reply', () => {})).rejects.toThrow('Existing composer draft');
      expect(await messages.locator('[contenteditable]').innerText()).toBe('Owner draft');
    } finally { await port.close(); }
  });
  it('clears only its own draft if Stop occurs before Send', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
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

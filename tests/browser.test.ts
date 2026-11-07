import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pino } from 'pino';
import { PlaywrightAdapter, blockedBy, jittered, looksOld, profileUrl } from '../src/browser.js';
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
      <div class="msg-conversation-listitem__link" onclick="openFixtureThread(1)">
        <span class="msg-conversation-listitem__active-text">Active</span>
        <h3 class="msg-conversation-listitem__participant-names">Synthetic contact</h3>
        <p class="msg-conversation-card__message-snippet">Hello!</p>
        <time class="msg-conversation-card__time-stamp">10:00 AM</time>
      </div>
    </li>
    <li class="msg-conversation-listitem">
      <div class="msg-conversation-listitem__link" onclick="openFixtureThread(2)">
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
    // Like the real app: the URL changes first, the message list refreshes shortly after.
    function openFixtureThread(n) {
      history.pushState({}, '', '/messaging/thread/synthetic-' + n + '/');
      if (window.__freezeList) return;
      setTimeout(() => {
        document.querySelector('.msg-s-event-listitem')
          .setAttribute('data-event-urn', 'urn:synthetic:incoming-' + n);
      }, 150);
    }
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
async function adapter(ownerUrl = '', html = fixture, env: Record<string, string> = {}) {
  const context = await browser.newContext();
  // All requests are fulfilled locally; no LinkedIn/network access in this suite.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const invitations = await context.newPage();
  const messages = await context.newPage();
  await messages.goto('https://www.linkedin.com/feed/');
  const port = new PlaywrightAdapter(context, invitations, messages,
    loadConfig({ ALLOW_EXTERNAL_LLM: 'true', OWNER_PROFILE_URL: ownerUrl, ...env }), pino({ level: 'silent' }));
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
  it('reloads pages only when a refresh is due, not on every poll', async () => {
    const mark = () => { (window as unknown as Record<string, unknown>)['__m'] = 'kept'; };
    const read = () => (window as unknown as Record<string, unknown>)['__m'];
    const calm = await adapter();
    try {
      await calm.invitations.evaluate(mark);
      await calm.port.invitations(); await calm.port.invitations(); await calm.port.invitations();
      expect(await calm.invitations.evaluate(read)).toBe('kept');
    } finally { await calm.port.close(); }
    const due = await adapter('', fixture, { INVITATION_REFRESH_MS: '1' });
    try {
      await due.invitations.evaluate(mark);
      await due.port.invitations();
      expect(await due.invitations.evaluate(read)).toBeUndefined();
    } finally { await due.port.close(); }
  });
  it('flags cards with clearly old activity that surface after startup, and fails open otherwise', async () => {
    const { port, messages } = await adapter();
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      await port.conversations();
      expect(port.staleConversations().size).toBe(0);
      await messages.evaluate(() => {
        const list = document.querySelector('ul.msg-conversations-container__conversations-list')!;
        const add = (n: number, name: string, label: string) => {
          const li = document.createElement('li');
          li.className = 'msg-conversation-listitem';
          li.innerHTML = '<div class="msg-conversation-listitem__link" onclick="openFixtureThread(' + n + ')">' +
            '<h3 class="msg-conversation-listitem__participant-names">' + name + '</h3>' +
            '<p class="msg-conversation-card__message-snippet">Hi</p>' +
            '<time class="msg-conversation-card__time-stamp">' + label + '</time></div>';
          list.append(li);
        };
        add(3, 'Old late contact', 'Nov 3');
        add(4, 'Fresh late contact', '6:31 PM');
        add(5, 'Unknown format contact', 'Just now');
      });
      const reported = await port.conversations();
      const base = 'https://www.linkedin.com/messaging/thread/synthetic-';
      expect(reported.sort()).toEqual([base + '3/', base + '4/', base + '5/']);
      expect([...port.staleConversations()]).toEqual([base + '3/']);
    } finally { await port.close(); }
  });
  it('after an acceptance, reloads the messaging page early and treats the surfacing thread as new', async () => {
    const mark = () => { (window as unknown as Record<string, unknown>)['__m'] = 'kept'; };
    const read = () => (window as unknown as Record<string, unknown>)['__m'];
    // 1 ms: the acceptance-triggered reload is due at once; the regular one is an hour away.
    const { port, messages } = await adapter('', fixture, { MESSAGE_REFRESH_MS: '3600000', POST_ACCEPT_REFRESH_MS: '1' });
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      await port.conversations();
      await messages.evaluate(mark);
      await port.conversations();
      expect(await messages.evaluate(read)).toBe('kept');
      port.noteAcceptance();
      await new Promise(resolve => setTimeout(resolve, 5));
      await port.conversations();
      expect(await messages.evaluate(read)).toBeUndefined();
      // The new connection's thread surfaces with an old note: not stale, so it gets answered.
      await messages.evaluate(() => {
        const list = document.querySelector('ul.msg-conversations-container__conversations-list')!;
        const li = document.createElement('li');
        li.className = 'msg-conversation-listitem';
        li.innerHTML = '<div class="msg-conversation-listitem__link" onclick="openFixtureThread(7)">' +
          '<h3 class="msg-conversation-listitem__participant-names">New connection</h3>' +
          '<p class="msg-conversation-card__message-snippet">Thanks for connecting</p>' +
          '<time class="msg-conversation-card__time-stamp">Nov 3</time></div>';
        list.append(li);
      });
      const reported = await port.conversations();
      expect(reported).toContain('https://www.linkedin.com/messaging/thread/synthetic-7/');
      expect(port.staleConversations().size).toBe(0);
    } finally { await port.close(); }
  });
  it('never pushes the acceptance reload later than one already planned', async () => {
    const { port } = await adapter('', fixture, { MESSAGE_REFRESH_MS: '1', POST_ACCEPT_REFRESH_MS: '3600000' });
    try {
      await port.conversations();
      const before = (port as unknown as { nextMessageRefresh: number }).nextMessageRefresh;
      port.noteAcceptance();
      expect((port as unknown as { nextMessageRefresh: number }).nextMessageRefresh).toBe(before);
    } finally { await port.close(); }
  });
  // Like the live inbox (inspect:live, Nov 2026): a folder dropdown whose pill names the current
  // folder; choosing "Other" swaps the list. Thread 1 lives in Focused, thread 9 in Other.
  const folderFixture = fixture
    .replace('<ul class="msg-conversations-container__conversations-list">',
      '<div class="msg-cross-pillar-inbox-filters-v3__container">' +
      '<button class="msg-cross-pillar-inbox-filters-v3__drop-down-trigger" ' +
      'data-test-messaging-inbox-filters__folder-pill onclick="window.__menu.hidden = false">Focused</button>' +
      '<div class="artdeco-dropdown__content" id="menu" hidden>' +
      '<ul><li onclick="pickFolder(\'Focused\')"><span>Focused</span></li>' +
      '<li onclick="pickFolder(\'Other\')"><span>Other</span></li>' +
      '<li onclick="pickFolder(\'Unread\')"><span>Unread</span></li></ul></div></div>' +
      '<ul class="msg-conversations-container__conversations-list">')
    .replace('<script>', '<script>\n' +
      'window.__menu = null; window.__switches = 0;\n' +
      'document.addEventListener("DOMContentLoaded", () => { window.__menu = document.getElementById("menu"); });\n' +
      'document.addEventListener("keydown", e => { if (e.key === "Escape" && window.__menu) window.__menu.hidden = true; });\n' +
      'const otherList = \'<li class="msg-conversation-listitem"><div class="msg-conversation-listitem__link" ' +
      'onclick="openFixtureThread(9)"><h3 class="msg-conversation-listitem__participant-names">Other contact</h3>' +
      '<p class="msg-conversation-card__message-snippet">Message request</p>' +
      '<time class="msg-conversation-card__time-stamp">Nov 2</time></div></li>\';\n' +
      'let focusedList = null;\n' +
      'function pickFolder(name) {\n' +
      '  window.__menu.hidden = true; window.__switches++;\n' +
      '  const pill = document.querySelector("[data-test-messaging-inbox-filters__folder-pill]");\n' +
      '  const list = document.querySelector("ul.msg-conversations-container__conversations-list");\n' +
      '  if (focusedList === null) focusedList = list.innerHTML;\n' +
      '  setTimeout(() => {\n' +
      '    pill.textContent = name;\n' +
      '    list.innerHTML = name === "Other" ? otherList : focusedList;\n' +
      '  }, 200);\n' +
      '}');
  it('reads both inbox folders through the folder dropdown and reopens cards in their own folder', async () => {
    const { port, messages } = await adapter('', folderFixture);
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      const first = await port.conversations();
      const base = 'https://www.linkedin.com/messaging/thread/synthetic-';
      expect(first.sort()).toEqual([base + '1/', base + '2/', base + '9/']);
      expect(await messages.locator('[data-test-messaging-inbox-filters__folder-pill]').innerText()).toBe('Other');
      // Reading the Other-folder thread again switches back to that folder, with no page load.
      await messages.evaluate(() => { (window as unknown as Record<string, unknown>)['__m'] = 'kept'; });
      await port.conversations();
      const thread = await port.thread(base + '9/');
      expect(thread.supported).toBe(true);
      expect(messages.url()).toBe(base + '9/');
      expect(await messages.evaluate(() => (window as unknown as Record<string, unknown>)['__m'])).toBe('kept');
      // Folder switches are in-app clicks only, and none happen when the pill already shows the folder.
      const switches = await messages.evaluate(() => (window as unknown as Record<string, unknown>)['__switches']);
      expect(switches).toBeGreaterThanOrEqual(3);
    } finally { await port.close(); }
  });
  it('reads only the focused folder when INBOX_FOLDERS=focused', async () => {
    const { port, messages } = await adapter('', folderFixture, { INBOX_FOLDERS: 'focused' });
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      const ids = await port.conversations();
      expect(ids).not.toContain('https://www.linkedin.com/messaging/thread/synthetic-9/');
      expect(await messages.evaluate(() => (window as unknown as Record<string, unknown>)['__switches'])).toBe(0);
    } finally { await port.close(); }
  });
  it('keeps reading the focused inbox when the folder dropdown is missing or lacks "Other"', async () => {
    const noOther = folderFixture.replace('<li onclick="pickFolder(\'Other\')"><span>Other</span></li>', '');
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => { lines.push(line); } });
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: noOther }));
    const invitations = await context.newPage();
    const messages = await context.newPage();
    await messages.goto('https://www.linkedin.com/feed/');
    const port = new PlaywrightAdapter(context, invitations, messages,
      loadConfig({ ALLOW_EXTERNAL_LLM: 'true' }), logger);
    try {
      await port.initialize();
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      const ids = await port.conversations();
      expect(ids).toContain('https://www.linkedin.com/messaging/thread/synthetic-1/');
      expect(lines.join('')).toContain('Could not switch inbox folder');
      expect(lines.join('')).not.toContain('Other contact');
      // The dropdown was closed again, so the list is still usable.
      expect(await messages.locator('#menu').isHidden()).toBe(true);
    } finally { await port.close(); }
  });
  it('jitters refresh times within +/-20% of the interval', () => {
    expect(jittered(1000, 100_000, () => 0)).toBeCloseTo(81_000);
    expect(jittered(1000, 100_000, () => 1)).toBeCloseTo(121_000);
    expect(jittered(1000, 100_000, () => 0.5)).toBeCloseTo(101_000);
  });
  it('classifies card activity labels as old only when clearly before today', () => {
    for (const old of ['Nov 3', 'Nov 3, 2025', '3 Nov', 'Yesterday', 'Fri', 'Saturday', '11/03/2025', '03.11.2025']) {
      expect(looksOld(old), old).toBe(true);
    }
    for (const fresh of ['6:31 PM', '18:31', '10:00 AM', 'Just now', 'Now', '5m', '', 'Today']) {
      expect(looksOld(fresh), fresh).toBe(false);
    }
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
      // Nothing changed: the second scan must not re-report (or reload) any thread.
      expect(await port.conversations()).toEqual([]);
      await messages.evaluate(() => {
        document.querySelector('.msg-conversation-card__message-snippet')!.textContent = 'New message';
      });
      const second = await port.conversations();
      expect(second).toEqual(['https://www.linkedin.com/messaging/thread/synthetic-1/']);
    } finally { await port.close(); }
  });
  it('switches threads by clicking cards, without a full page load', async () => {
    const { port, messages } = await adapter();
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      await messages.evaluate(() => { (window as unknown as Record<string, unknown>)['__marker'] = 'kept'; });
      const one = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      const two = 'https://www.linkedin.com/messaging/thread/synthetic-2/';
      await port.conversations();
      const a = await port.thread(two);
      const b = await port.thread(one);
      const c = await port.thread(two);
      expect(a.supported && b.supported && c.supported).toBe(true);
      expect(new URL(messages.url()).pathname).toBe('/messaging/thread/synthetic-2/');
      // A full page load would have reset this window variable.
      expect(await messages.evaluate(() =>
        (window as unknown as Record<string, unknown>)['__marker'])).toBe('kept');
      expect(a.messages[0]?.id).not.toBe(b.messages[0]?.id);
      expect(a.messages[0]?.id).toBe(c.messages[0]?.id);
    } finally { await port.close(); }
  });
  it('never reads a stale view of the previous thread as the requested one', async () => {
    const { port, messages } = await adapter();
    try {
      await messages.goto('https://www.linkedin.com/messaging/thread/synthetic-1/');
      await port.conversations();
      await messages.evaluate(() => { (window as unknown as Record<string, unknown>)['__freezeList'] = true; });
      await expect(port.thread('https://www.linkedin.com/messaging/thread/synthetic-1/'))
        .rejects.toThrow('did not update');
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
        .rejects.toThrow(/Send button not visible after typing \(msg-form__send-toggle visible=true/);
      expect((await messages.locator('[contenteditable]').innerText()).trim()).toBe('');
    } finally { await port.close(); }
  });
  it('sends only through the composer form\'s visible Send button, never another one on the page', async () => {
    const html = fixture.replace('<form class="msg-form">',
      '<form class="other"><button type="submit" class="msg-form__send-button" ' +
      'onclick="window.__wrong = true; return false">Wrong</button></form><form class="msg-form">');
    const { port, messages } = await adapter('', html);
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await port.send(id, 'Right button', () => {});
      expect(await messages.evaluate(() => (window as unknown as Record<string, unknown>)['__wrong'])).toBeUndefined();
      expect(await messages.locator('[data-event-urn="urn:synthetic:own"]').innerText()).toContain('Right button');
    } finally { await port.close(); }
  });
  it('types with real keystrokes, so a Send button revealed only by key events appears', async () => {
    const html = fixture.replace('oninput="toggleSend()"', 'onkeyup="toggleSend()"');
    const { port, messages } = await adapter('', html);
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await port.send(id, 'Typed reply', () => {});
      expect(await messages.locator('[data-event-urn="urn:synthetic:own"]').innerText()).toContain('Typed reply');
    } finally { await port.close(); }
  });
  it('fails before dispatch when Send is covered, naming what covers it', async () => {
    const html = fixture.replace('form.append(button);', 'form.append(button);' +
      'const o = document.createElement("div"); o.className = "overlay";' +
      'o.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:9999";' +
      'document.body.append(o);');
    const { port, messages } = await adapter('', html);
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      let dispatched = false;
      await expect(port.send(id, 'Covered', () => { dispatched = true; }))
        .rejects.toThrow(/Send button is not clickable \(.*covered by div\.overlay\)/);
      expect(dispatched).toBe(false);
      expect(await messages.locator('[data-event-urn="urn:synthetic:own"]').count()).toBe(0);
      expect((await messages.locator('[contenteditable]').innerText()).trim()).toBe('');
    } finally { await port.close(); }
  });
  it('fails before dispatch when the Accept button cannot be clicked', async () => {
    const html = fixture.replace('<main>', '<div class="overlay" ' +
      'style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:9999"></div><main>');
    const { port, invitations } = await adapter('', html);
    try {
      invitations.context().setDefaultTimeout(1_500);
      let dispatched = false;
      await expect(port.accept('https://www.linkedin.com/in/synthetic-contact/', () => { dispatched = true; }))
        .rejects.toThrow(/Accept button is not clickable \(.*covered by div\.overlay\)/);
      expect(dispatched).toBe(false);
    } finally { await port.close(); }
  });
  it('waits for a Send button that is always visible but enables only after typing', async () => {
    // Like the live UI (probe:send): rendered at once, disabled while empty, enabled shortly after input.
    const html = fixture.replace('<button type="button" class="msg-form__send-toggle">Mode</button>',
      '<button type="submit" class="msg-form__send-button" disabled onclick="event.preventDefault(); sendSynthetic()">Send</button>' +
      '<button type="button" class="msg-form__send-toggle">Mode</button>')
      .replace('function toggleSend() {', 'function toggleSend() {' +
        'const live = document.querySelector(".msg-form__send-button");' +
        'const filled = document.querySelector("[contenteditable]").textContent.trim().length > 0;' +
        'clearTimeout(window.__enable);' +
        'if (live) { if (filled) window.__enable = setTimeout(() => { live.disabled = false; }, 600); else live.disabled = true; return; }');
    const { port, messages } = await adapter('', html);
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await port.send(id, 'Patient reply', () => {});
      expect(await messages.locator('[data-event-urn="urn:synthetic:own"]').innerText()).toContain('Patient reply');
    } finally { await port.close(); }
  });
  it('fails before dispatch when Send never becomes enabled', async () => {
    const html = fixture.replace('<button type="button" class="msg-form__send-toggle">Mode</button>',
      '<button type="submit" class="msg-form__send-button" disabled>Send</button>' +
      '<button type="button" class="msg-form__send-toggle">Mode</button>')
      .replace('function toggleSend() {', 'function toggleSend() { if (document.querySelector(".msg-form__send-button")) return;');
    const { port, messages } = await adapter('', html);
    try {
      messages.context().setDefaultTimeout(1_500);
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      let dispatched = false;
      await expect(port.send(id, 'Never enabled', () => { dispatched = true; }))
        .rejects.toThrow(/Send button is not clickable \(matches=1 visible=true enabled=false/);
      expect(dispatched).toBe(false);
      expect((await messages.locator('[contenteditable]').innerText()).trim()).toBe('');
    } finally { await port.close(); }
  });
  it('probes the Send control without sending, and removes its character', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      const probe = await port.probeSend();
      expect(probe).toMatchObject({ composerInForm: true, sendVisible: true, sendEnabled: true,
        sendClickable: true, composerCleared: true });
      expect(probe.controlsBefore.map(c => c.classes)).toEqual(['msg-form__send-toggle']);
      expect(probe.controlsAfterTyping.find(c => c.classes === 'msg-form__send-button'))
        .toMatchObject({ type: 'submit', visible: true, enabled: true });
      expect(await messages.locator('[data-event-urn="urn:synthetic:own"]').count()).toBe(0);
      expect(JSON.stringify(probe)).not.toContain('synthetic-contact');
    } finally { await port.close(); }
  });
  it('probe reports a Send button that never appears, and still clears its character', async () => {
    const { port, messages } = await adapter();
    try {
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.evaluate(() => { document.querySelector('[contenteditable]')!.removeAttribute('oninput'); });
      const probe = await port.probeSend();
      expect(probe).toMatchObject({ sendVisible: false, sendEnabled: null, sendClickable: null,
        composerCleared: true });
    } finally { await port.close(); }
  });
  it('probe refuses without an open conversation or over an existing draft', async () => {
    const { port, messages } = await adapter();
    try {
      await expect(port.probeSend()).rejects.toThrow('No conversation is open');
      const id = 'https://www.linkedin.com/messaging/thread/synthetic-1/';
      await port.thread(id);
      await messages.locator('[contenteditable]').fill('Owner draft');
      await expect(port.probeSend()).rejects.toThrow('already contains text');
      expect(await messages.locator('[contenteditable]').innerText()).toBe('Owner draft');
    } finally { await port.close(); }
  });
  it('names only the tag and classes of the element covering a click', () => {
    expect(blockedBy(new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - <div class="a b c d">Secret name</div> intercepts pointer events')))
      .toBe(' covered by div.a.b.c');
    expect(blockedBy(new Error('x\n  - <div>no class</div> intercepts pointer events'))).toBe(' covered by another element');
    expect(blockedBy(new Error('plain timeout'))).toBe('');
    expect(blockedBy('not an error')).toBe('');
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
  it('verifies acceptance through the visible "More" button and the menu that opens after a delay', async () => {
    const { port, invitations } = await adapter();
    try {
      await invitations.route('**/in/**', route => route.fulfill({
        contentType: 'text/html', body: `<nav class="global-nav"><a href="/messaging/">Messaging</a></nav>
          <button hidden>More hidden</button>
          <button aria-label="More actions" onclick="setTimeout(() => document.querySelector('[role=menuitem]').hidden = false, 400)">More</button>
          <div role="menuitem" hidden>Remove connection</div>` }));
      expect(await port.verifyAcceptance('https://www.linkedin.com/in/synthetic-contact/')).toBe('confirmed');
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

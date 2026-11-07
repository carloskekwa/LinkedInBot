import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { loadSelectors, type Selectors } from './selectors.js';
import { hash, messageId, parseReceipt, unknownReceipt } from './time.js';
import type { Invitation, LinkedInPort, Message, Thread, Verification } from './types.js';

const origin = 'https://www.linkedin.com';
export function profileUrl(raw: string): string {
  const url = new URL(raw, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/in/')) {
    throw new Error('Unexpected profile link; refusing navigation');
  }
  return `${origin}${url.pathname.replace(/\/+$/, '')}/`;
}
function threadUrl(raw: string): string {
  const url = new URL(raw, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/messaging/thread/')) {
    throw new Error('Unexpected conversation link');
  }
  return `${origin}${url.pathname}`;
}
async function optionalText(locator: Locator): Promise<string> {
  return await locator.count() ? (await locator.first().innerText()).trim() : '';
}
export class PlaywrightAdapter implements LinkedInPort {
  private owner = '';
  private readonly selectors: Selectors;
  private openThread = '';
  private lastInvitationRefresh = 0;
  private lastMessageRefresh = 0;
  constructor(
    private context: BrowserContext, private invitationsPage: Page,
    private messagesPage: Page, config: Config, private log: Logger,
  ) { this.selectors = loadSelectors(config.SELECTORS_FILE); }

  static async open(config: Config, log: Logger): Promise<PlaywrightAdapter> {
    const context = await chromium.launchPersistentContext(config.BROWSER_PROFILE, {
      headless: false, viewport: { width: 1280, height: 900 },
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(25_000);
    try {
      const invitations = context.pages()[0] ?? await context.newPage();
      const messages = await context.newPage();
      // Never restore arbitrary prior tabs into the bot's worker set.
      for (const page of context.pages()) {
        if (page !== invitations && page !== messages) await page.close();
      }
      const adapter = new PlaywrightAdapter(context, invitations, messages, config, log);
      await messages.goto(`${origin}/feed/`, { waitUntil: 'domcontentloaded' });
      return adapter;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  async login(signal: AbortSignal): Promise<void> {
    this.log.info('Log in manually in Chromium. Resolve any checkpoint yourself.');
    while (!signal.aborted) {
      if (await this.isAuthenticated(this.messagesPage)) return;
      await delay(1_000, undefined, { signal });
    }
    signal.throwIfAborted();
  }
  private async isAuthenticated(page: Page): Promise<boolean> {
    if (page.isClosed()) throw new Error('Worker browser page closed');
    const url = new URL(page.url());
    if (url.origin !== origin || /\/(login|checkpoint|authwall|uas)\b/.test(url.pathname)) return false;
    return page.locator(this.selectors.nav).first().isVisible();
  }
  async authenticated(): Promise<boolean> {
    const pages = [this.messagesPage, this.invitationsPage];
    if (pages.some(page => /\/checkpoint\b/.test(new URL(page.url()).pathname))) return false;
    const authenticated = await Promise.all(pages.map(page => this.isAuthenticated(page)));
    // Shared cookies let the workers restore their own login-redirected page once
    // the owner has reauthenticated on either tab. No cross-worker navigation.
    return authenticated.some(Boolean);
  }
  async initialize(): Promise<void> {
    const owner = this.messagesPage.locator(this.selectors.ownerProfile).first();
    if (!await owner.count()) {
      await this.messagesPage.locator(this.selectors.me).first().click();
    }
    const href = await owner.getAttribute('href');
    if (!href) throw new Error('Cannot capture owner profile identity; update ownerProfile selector');
    this.owner = profileUrl(href);
    await this.invitationsPage.goto(`${origin}/mynetwork/invitation-manager/`,
      { waitUntil: 'domcontentloaded' });
    await this.messagesPage.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded' });
    await this.healthCheck();
  }
  ownerIdentity(): string {
    if (!this.owner) throw new Error('Initialize the adapter before requesting owner identity');
    return this.owner;
  }
  async healthCheck(): Promise<void> {
    await this.messagesPage.locator(this.selectors.conversationList).first().waitFor();
    await this.invitationsPage.locator(
      `${this.selectors.invitationList}, ${this.selectors.invitationsEmpty}`,
    ).first().waitFor();
    this.log.info('Startup list selectors verified. Per-thread/write selectors still need live validation.');
  }
  private async ensureInvitationList(): Promise<void> {
    if (!this.invitationsPage.url().includes('/invitation-manager')) {
      await this.invitationsPage.goto(`${origin}/mynetwork/invitation-manager/`,
        { waitUntil: 'domcontentloaded' });
    } else if (Date.now() - this.lastInvitationRefresh > 60_000) {
      // A parked page is not guaranteed to receive invitations live.
      await this.invitationsPage.reload({ waitUntil: 'domcontentloaded' });
      this.lastInvitationRefresh = Date.now();
    }
    await this.invitationsPage.locator(
      `${this.selectors.invitationList}, ${this.selectors.invitationsEmpty}`,
    ).first().waitFor();
  }
  async invitations(): Promise<Invitation[]> {
    await this.ensureInvitationList();
    const cards = this.invitationsPage.locator(this.selectors.invitationCard);
    const results: Invitation[] = [];
    for (const card of await cards.all()) {
      const href = await card.locator(this.selectors.invitationProfile).first().getAttribute('href');
      if (!href) throw new Error('Invitation has no profile identifier');
      const time = card.locator(this.selectors.invitationTime);
      const rawTime = await time.count()
        ? await time.first().getAttribute('datetime') ?? await optionalText(time) : null;
      results.push({ id: profileUrl(href), receipt: parseReceipt(rawTime, Date.now()) });
    }
    return results;
  }
  async accept(id: string, beforeClick: () => void): Promise<void> {
    await this.ensureInvitationList();
    if (!await this.authenticated()) throw new Error('Authentication required');
    for (const card of await this.invitationsPage.locator(this.selectors.invitationCard).all()) {
      const href = await card.locator(this.selectors.invitationProfile).first().getAttribute('href');
      if (href && profileUrl(href) === id) {
        const accept = card.locator(this.selectors.invitationAccept).first();
        await accept.waitFor();
        beforeClick();
        await accept.click();
        return;
      }
    }
    throw new Error('Invitation disappeared before acceptance; reconcile before any retry');
  }
  async verifyAcceptance(id: string): Promise<Verification> {
    // Card disappearance alone cannot distinguish acceptance from withdrawal.
    await this.invitationsPage.goto(profileUrl(id), { waitUntil: 'domcontentloaded' });
    if (!await this.isAuthenticated(this.invitationsPage)) return 'uncertain';
    const more = this.invitationsPage.locator(this.selectors.profileMore).first();
    if (!await more.count()) return 'uncertain';
    await more.click();
    const connected = await this.invitationsPage.locator(this.selectors.removeConnection).first().isVisible();
    await this.invitationsPage.keyboard.press('Escape');
    return connected ? 'confirmed' : 'uncertain';
  }
  async conversations(): Promise<string[]> {
    if (!this.messagesPage.url().includes('/messaging/')) {
      await this.messagesPage.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded' });
      this.openThread = '';
    } else if (Date.now() - this.lastMessageRefresh > 300_000) {
      await this.messagesPage.reload({ waitUntil: 'domcontentloaded' });
      this.lastMessageRefresh = Date.now();
      this.openThread = '';
    }
    await this.messagesPage.locator(this.selectors.conversationList).first().waitFor();
    const links = await this.messagesPage.locator(this.selectors.conversationLink).all();
    const result = new Set<string>();
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (href) result.add(threadUrl(href));
    }
    return [...result];
  }
  private async openConversation(id: string): Promise<void> {
    const safe = threadUrl(id);
    if (this.openThread !== safe) {
      // Direct navigation is the reliable fallback until SPA switching is live-verified.
      await this.messagesPage.goto(safe, { waitUntil: 'domcontentloaded' });
      this.openThread = safe;
    }
    await this.messagesPage.locator(this.selectors.thread).first().waitFor();
  }
  async thread(id: string): Promise<Thread> {
    await this.openConversation(id);
    const recipients = this.messagesPage.locator(this.selectors.recipient);
    const recipientLinks = new Set<string>();
    for (const recipient of await recipients.all()) {
      const href = await recipient.getAttribute('href');
      if (href) recipientLinks.add(profileUrl(href));
    }
    const supported = recipientLinks.size === 1 &&
      !await this.messagesPage.locator(this.selectors.unsupported).count();
    if (!supported) {
      this.log.warn({ ref: hash(id) }, 'Unsupported or unidentified thread; skipped (check recipient selectors)');
      return { id, messages: [], supported: false };
    }
    const events = await this.messagesPage.locator(this.selectors.message).all();
    const messages: Message[] = [];
    let sender: string | null = null;
    const occurrences = new Map<string, number>();
    for (const event of events) {
      const text = await optionalText(event.locator(this.selectors.messageText));
      const attachment = await event.locator(this.selectors.attachment).count() > 0;
      if (!await event.locator(this.selectors.messageText).count() && !attachment) continue;
      const senderLink = event.locator(this.selectors.messageSender).first();
      const href = await senderLink.count() ? await senderLink.getAttribute('href') : null;
      if (href) sender = profileUrl(href);
      const ownMarker = await event.evaluate((element, selector) => element.matches(selector),
        this.selectors.messageOwn);
      if (ownMarker) sender = this.owner;
      if (!sender) throw new Error('Message sender cannot be established; refusing automatic reply');
      if (sender !== this.owner && !recipientLinks.has(sender)) {
        throw new Error('Unexpected sender in one-to-one thread; refusing automatic reply');
      }
      const own = sender === this.owner;
      const time = event.locator(this.selectors.messageTime).first();
      const absoluteTime = await time.count() ? await time.getAttribute('datetime') : null;
      const raw = absoluteTime ?? (await time.count() ? await time.innerText() : null);
      const stableId = await event.getAttribute('data-event-urn') ?? await event.getAttribute('data-message-id');
      const occurrenceKey = hash(JSON.stringify([sender, text, absoluteTime]));
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      if (!stableId && !absoluteTime) this.log.debug({ ref: hash(id) },
        'Message identity uses DOM occurrence fallback; duplicate protection is best-effort');
      messages.push({
        id: messageId(id, stableId, text, own, absoluteTime, occurrence),
        own, text, attachment,
        transportConfirmed: stableId !== null &&
          !await event.evaluate((element, selector) =>
            element.matches(selector) || element.querySelector(selector) !== null,
          this.selectors.messagePending),
        receipt: raw ? parseReceipt(raw, Date.now()) : unknownReceipt(),
      });
    }
    return { id, messages, supported: true };
  }
  async send(id: string, text: string, beforeClick: () => void): Promise<void> {
    await this.openConversation(id);
    if (!await this.authenticated()) throw new Error('Authentication required');
    const composer = this.messagesPage.locator(this.selectors.composer).first();
    if ((await composer.innerText()).trim()) {
      throw new Error('Existing composer draft found; refusing to overwrite or send it');
    }
    const send = this.messagesPage.locator(this.selectors.send).first();
    try {
      await composer.fill(text);
      await send.waitFor();
      if (!await send.isEnabled()) throw new Error('Send button disabled');
      beforeClick();
      await send.click();
    } catch (error) {
      // Clear only the bot's exact draft. Never clear user-authored edits.
      if (!this.messagesPage.isClosed() && (await composer.innerText()).trim() === text.trim()) {
        await composer.fill('');
      }
      throw error;
    }
  }
  async verifySend(id: string, textHash: string, afterMessageId: string): Promise<Verification> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const thread = await this.thread(id);
      const anchor = thread.messages.findIndex(m => m.id === afterMessageId);
      if (anchor >= 0 && thread.messages.slice(anchor + 1).some(m =>
        m.own && m.transportConfirmed && hash(m.text.trim()) === textHash)) {
        return 'confirmed';
      }
      if (attempt < 2) await delay(5_000);
    }
    return 'uncertain';
  }
  async close(): Promise<void> { await this.context.close(); }
}

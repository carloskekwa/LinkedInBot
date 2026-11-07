import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { loadSelectors, type Selectors } from './selectors.js';
import { safeDetail } from './errors.js';
import { hash, messageId, parseReceipt, unknownReceipt } from './time.js';
import type { Invitation, LinkedInPort, Message, Thread, Verification } from './types.js';

const origin = 'https://www.linkedin.com';
export type InboxFolder = 'focused' | 'other';
// How long to wait for the conversation list to show a newly selected folder.
const FOLDER_SWITCH_MS = 8_000;
// How long to wait for the message view to refresh after switching conversations.
const SWITCH_SETTLE_MS = 5_000;
// The "?invitationType=" filter did not narrow the list in practice (Page/newsletter
// invitations still appeared), so the plain validated URL is used and cards are filtered.
const invitationsUrl = `${origin}/mynetwork/invitation-manager/received/`;
export function profileUrl(raw: string): string {
  const result = tryProfileUrl(raw);
  if (!result) throw new Error('Unexpected profile link; refusing navigation');
  return result;
}
// Null for anything that is not a personal profile (company/school pages, external links).
export function tryProfileUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw, origin); } catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith('/in/')) return null;
  return `${origin}${url.pathname.replace(/\/+$/, '')}/`;
}
function threadUrl(raw: string): string {
  const url = new URL(raw, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/messaging/thread/')) {
    throw new Error('Unexpected conversation link');
  }
  return `${origin}${url.pathname}`;
}
// Next refresh time: the interval +/-20%, so reloads do not land on a fixed rhythm.
export function jittered(now: number, intervalMs: number, random: () => number = Math.random): number {
  return now + intervalMs * (0.8 + random() * 0.4);
}
// A card label that clearly means "before today" (weekday, date, "Yesterday"). Anything
// else, including times of day and unrecognised formats, counts as fresh, so an unknown
// format can never cause a real new message to be ignored.
export function looksOld(label: string): boolean {
  const value = label.trim();
  return /^(yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i.test(value) ||
    /^[A-Za-z]{3,9}\.?\s+\d{1,2}(,\s*\d{4})?$/.test(value) ||
    /^\d{1,2}\s+[A-Za-z]{3,9}\.?(\s+\d{4})?$/.test(value) ||
    /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(value);
}
async function optionalText(locator: Locator): Promise<string> {
  return await locator.count() ? (await locator.first().innerText()).trim() : '';
}
// Typing speed: about one character per 20 ms, so a 300-character reply takes ~6 s.
const TYPING_DELAY_MS = 20;
// Contenteditable text mixes &nbsp; with spaces, so compare with whitespace normalised.
const normalized = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim();

// Structural facts about a control (class names and booleans, never text), for diagnosis.
export interface ControlInfo {
  tag: string; classes: string; type: string | null; ariaLabel: string;
  visible: boolean; enabled: boolean; ariaHidden: string | null;
  ariaExpanded: string | null; ariaChecked: string | null;
}
export interface SendProbe {
  generatedAt: string; sendSelector: string; composerInForm: boolean;
  controlsBefore: ControlInfo[]; controlsAfterTyping: ControlInfo[];
  sendVisible: boolean; sendEnabled: boolean | null; sendClickable: boolean | null;
  composerCleared: boolean;
}
async function sendControls(scope: Locator | Page): Promise<ControlInfo[]> {
  return scope.locator('button, [role="button"]').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      classes: (typeof element.className === 'string' ? element.className : '')
        .trim().split(/\s+/).slice(0, 4).join('.'),
      type: element.getAttribute('type'),
      ariaLabel: (element.getAttribute('aria-label') ?? '').slice(0, 40),
      visible: element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      enabled: !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true',
      ariaHidden: element.getAttribute('aria-hidden'),
      ariaExpanded: element.getAttribute('aria-expanded'),
      ariaChecked: element.getAttribute('aria-checked'),
    };
  }));
}
async function describeControls(scope: Locator | Page): Promise<string> {
  try {
    const controls = (await sendControls(scope)).slice(0, 8);
    if (!controls.length) return 'no buttons found in the composer form';
    return controls.map(c => `${c.classes || c.tag} visible=${c.visible} enabled=${c.enabled}`).join('; ');
  } catch { return 'controls could not be read'; }
}
async function describeLocator(locator: Locator): Promise<string> {
  try {
    return `matches=${await locator.count()} visible=${await locator.isVisible()} enabled=${await locator.isEnabled()}`;
  } catch { return 'state could not be read'; }
}
// Playwright's click log names what covers a target ("<div class="a b"> intercepts pointer
// events"). Only the tag and class names are kept, never text or attributes.
export function blockedBy(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const match = /<([a-z][a-z0-9-]*)\b[^>]*?\bclass="([^"]{0,200})"[^>]*>[^\n]*?intercepts pointer events/i.exec(message);
  if (!match) return /intercepts pointer events/i.test(message) ? ' covered by another element' : '';
  const classes = match[2]!.trim().split(/\s+/).slice(0, 3).join('.');
  return ` covered by ${match[1]}${classes ? `.${classes}` : ''}`;
}
export class PlaywrightAdapter implements LinkedInPort {
  private owner = '';
  private readonly selectors: Selectors;
  private readonly configuredOwner: string;
  private openThread = '';
  private nextInvitationRefresh = 0;
  private nextMessageRefresh = 0;
  private readonly invitationRefreshMs: number;
  private readonly messageRefreshMs: number;
  private readonly postAcceptRefreshMs: number;
  // Until this time, late-surfacing threads with old activity are not marked stale.
  private freshUntil = 0;
  private readonly folders: InboxFolder[];
  // Folder the loaded list currently shows; null right after a (re)load, when it is unknown.
  private currentFolder: InboxFolder | null = null;
  private readonly scannedFolders = new Set<InboxFolder>();
  // Which folder each discovered thread's card was found in, so it can be re-opened by card.
  private readonly threadFolder = new Map<string, InboxFolder>();
  private lastFolderWarning = 0;
  private readonly threadLimit: number;
  private readonly changeWindowMs: number;
  // In-memory only: participant-name hash -> thread URL, preview fingerprints, change times.
  private readonly knownThreads = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly changedAt = new Map<string, number>();
  private readonly cardRetryAt = new Map<string, number>();
  private readonly staleLate = new Set<string>();
  // Alternative URL forms of the owner's own profile link, learned from one-to-one threads.
  private readonly ownerAliases = new Set<string>();
  constructor(
    private context: BrowserContext, private invitationsPage: Page,
    private messagesPage: Page, config: Config, private log: Logger,
  ) {
    this.selectors = loadSelectors(config.SELECTORS_FILE);
    this.configuredOwner = config.OWNER_PROFILE_URL;
    this.threadLimit = config.THREAD_LIMIT;
    this.invitationRefreshMs = config.INVITATION_REFRESH_MS;
    this.messageRefreshMs = config.MESSAGE_REFRESH_MS;
    this.postAcceptRefreshMs = config.POST_ACCEPT_REFRESH_MS;
    this.folders = config.INBOX_FOLDERS.split(',') as InboxFolder[];
    // Long enough for the debounce cap plus two polls to observe the final message.
    this.changeWindowMs = config.MAX_DEBOUNCE_MS + 2 * config.MESSAGE_POLL_MS;
  }
  // Pulls the next messaging reload forward to about POST_ACCEPT_REFRESH_MS from now (never
  // later than already planned). Threads surfacing for a while afterwards are treated as new
  // even if their last activity looks old: a connection note is often days older than its
  // acceptance, and it still deserves an answer.
  noteAcceptance(): void {
    const planned = jittered(Date.now(), this.postAcceptRefreshMs);
    this.nextMessageRefresh = Math.min(this.nextMessageRefresh || planned, planned);
    // Long enough for the reload, lazy card rendering and the debounce; at least 10 minutes.
    this.freshUntil = Math.max(this.freshUntil, planned + Math.max(600_000, 2 * this.postAcceptRefreshMs));
    this.log.info({ refreshInSeconds: Math.round((this.nextMessageRefresh - Date.now()) / 1000) },
      'Connection accepted; messaging page will reload so the new thread moves into the inbox');
  }

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
    let nextDiagnostic = Date.now() + 30_000;
    while (!signal.aborted) {
      if (await this.isAuthenticated(this.messagesPage)) {
        this.log.info('Authenticated navigation detected; continuing startup');
        return;
      }
      if (Date.now() >= nextDiagnostic) {
        const path = new URL(this.messagesPage.url()).pathname;
        this.log.warn({
          pagePath: ['/feed/', '/messaging/', '/login', '/checkpoint/', '/authwall'].includes(path)
            ? path : 'other',
          navigationMatches: await this.messagesPage.locator(this.selectors.nav).count(),
        }, 'Still waiting for authenticated navigation. If already logged in, check the nav selector; monitoring has not started');
        nextDiagnostic = Date.now() + 30_000;
      }
      await delay(1_000, undefined, { signal });
    }
    signal.throwIfAborted();
  }
  private async isAuthenticated(page: Page): Promise<boolean> {
    if (page.isClosed()) throw new Error('Worker browser page closed');
    const url = new URL(page.url());
    if (url.origin !== origin || /\/(login|checkpoint|authwall|uas)\b/.test(url.pathname)) return false;
    return await page.locator(this.selectors.nav).filter({ visible: true }).count() > 0;
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
    if (this.configuredOwner) {
      this.owner = profileUrl(this.configuredOwner);
      this.log.info('Using explicitly configured owner profile; verify it belongs to the logged-in account');
    } else {
      const owner = this.messagesPage.locator(this.selectors.ownerProfile).first();
      if (!await owner.count()) {
        const me = this.messagesPage.locator(this.selectors.me).filter({ visible: true }).first();
        if (!await me.count()) {
          throw new Error('Owner menu not found. Set OWNER_PROFILE_URL to your own LinkedIn profile URL in .env');
        }
        await me.click();
      }
      const href = await owner.getAttribute('href');
      if (!href) throw new Error('Cannot capture owner identity; set OWNER_PROFILE_URL or update ownerProfile selector');
      this.owner = profileUrl(href);
    }
    await this.invitationsPage.goto(invitationsUrl, { waitUntil: 'domcontentloaded' });
    await this.messagesPage.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded' });
    this.nextInvitationRefresh = jittered(Date.now(), this.invitationRefreshMs);
    this.nextMessageRefresh = jittered(Date.now(), this.messageRefreshMs);
    await this.healthCheck();
  }
  ownerIdentity(): string {
    if (!this.owner) throw new Error('Initialize the adapter before requesting owner identity');
    return this.owner;
  }
  async healthCheck(): Promise<void> {
    await this.messagesPage.locator(this.selectors.conversationList).first().waitFor();
    await this.invitationsPage.locator('main').first().waitFor();
    this.log.info('Startup list selectors verified. Per-thread/write selectors still need live validation.');
  }
  private async ensureInvitationList(): Promise<void> {
    if (!this.invitationsPage.url().includes('/invitation-manager')) {
      this.nextInvitationRefresh = jittered(Date.now(), this.invitationRefreshMs);
      await this.invitationsPage.goto(invitationsUrl, { waitUntil: 'domcontentloaded' });
    } else if (Date.now() >= this.nextInvitationRefresh) {
      // A parked page is not guaranteed to receive invitations live. The next reload is
      // scheduled first, so a failing reload is not retried on every poll.
      this.nextInvitationRefresh = jittered(Date.now(), this.invitationRefreshMs);
      await this.invitationsPage.reload({ waitUntil: 'domcontentloaded' });
    }
    await this.invitationsPage.locator('main').first().waitFor();
    await this.invitationsPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  }
  // Connection requests only. Page-follow and newsletter invitations share the same
  // list; their Accept labels read "<Page> invitation for <Person>" / "invitation for <Newsletter>".
  private async connectionCards(): Promise<{ card: Locator; id: string }[]> {
    const results: { card: Locator; id: string }[] = [];
    let skipped = 0;
    for (const card of await this.invitationsPage.locator(this.selectors.invitationCard).all()) {
      const accept = card.locator(this.selectors.invitationAccept).first();
      if (!await accept.count()) continue;
      const label = (await accept.getAttribute('aria-label')) ?? await optionalText(accept);
      const profile = card.locator(this.selectors.invitationProfile).first();
      const href = await profile.count() ? await profile.getAttribute('href') : null;
      if (!href || /\binvitation for\b/i.test(label) || !/\binvitation\b/i.test(label)) { skipped++; continue; }
      results.push({ card, id: profileUrl(href) });
    }
    if (skipped) this.log.debug({ skipped }, 'Skipped non-connection invitations (pages/newsletters)');
    return results;
  }
  async invitations(): Promise<Invitation[]> {
    await this.ensureInvitationList();
    const results: Invitation[] = [];
    for (const { card, id } of await this.connectionCards()) {
      const time = card.locator(this.selectors.invitationTime);
      let rawTime = await time.count()
        ? await time.first().getAttribute('datetime') ?? await optionalText(time) : null;
      if (!rawTime) {
        // Card text is parsed for a relative age only; it is not stored.
        rawTime = /\b(\d+)\s*(second|minute|hour|day|week)s?\s+ago\b/i
          .exec(await card.innerText())?.[0] ?? null;
      }
      results.push({ id, receipt: parseReceipt(rawTime, Date.now()) });
    }
    return results;
  }
  async accept(id: string, beforeClick: () => void): Promise<void> {
    await this.ensureInvitationList();
    if (!await this.authenticated()) throw new Error('Authentication required');
    for (const entry of await this.connectionCards()) {
      if (entry.id === id) {
        const accept = entry.card.locator(this.selectors.invitationAccept).first();
        await accept.waitFor();
        // A trial click runs every actionability check without clicking, so a button that cannot
        // be clicked fails here, before the click is recorded as dispatched.
        try { await accept.click({ trial: true }); }
        catch (error) {
          throw new Error(`Accept button is not clickable (${await describeLocator(accept)}${blockedBy(error)})`,
            { cause: error });
        }
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
    // Visible matches only: `button:has-text("More")` also matches hidden buttons elsewhere on
    // the page, and clicking one of those times out.
    const more = this.invitationsPage.locator(this.selectors.profileMore).filter({ visible: true }).first();
    if (!await more.count()) return 'uncertain';
    await more.click();
    // The menu renders a moment after the click, so wait briefly instead of checking once.
    const connected = await this.invitationsPage.locator(this.selectors.removeConnection).first()
      .waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
    await this.invitationsPage.keyboard.press('Escape');
    return connected ? 'confirmed' : 'uncertain';
  }
  async conversations(): Promise<string[]> {
    if (!this.messagesPage.url().includes('/messaging/')) {
      this.nextMessageRefresh = jittered(Date.now(), this.messageRefreshMs);
      await this.messagesPage.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded' });
      this.openThread = '';
      this.currentFolder = null;
    } else if (Date.now() >= this.nextMessageRefresh) {
      this.nextMessageRefresh = jittered(Date.now(), this.messageRefreshMs);
      await this.messagesPage.reload({ waitUntil: 'domcontentloaded' });
      this.openThread = '';
      this.currentFolder = null;
    }
    await this.messagesPage.locator(this.selectors.conversationList).first().waitFor();
    const links = await this.messagesPage.locator(this.selectors.conversationLink).all();
    if (links.length) {
      const result = new Set<string>();
      for (const link of links) {
        const href = await link.getAttribute('href');
        if (href) result.add(threadUrl(href));
      }
      return [...result];
    }
    const reported = new Set<string>();
    for (const folder of this.folders) {
      try { await this.switchFolder(folder); }
      catch (error) {
        // The folder UI is unverified live. Reading the other folders still works.
        if (Date.now() - this.lastFolderWarning > 3_600_000) {
          this.lastFolderWarning = Date.now();
          this.log.warn({ folder, detail: safeDetail(error) },
            'Could not switch inbox folder; that folder is not being read. Check the inboxFolder* selectors');
        }
        continue;
      }
      for (const id of await this.discoverConversations(folder)) reported.add(id);
    }
    return [...reported];
  }
  private folderLabel(folder: InboxFolder): string {
    return folder === 'focused' ? this.selectors.inboxFolderFocused : this.selectors.inboxFolderOther;
  }
  // Selects an inbox folder through the folder dropdown, in-app, with no page load. The pill
  // shows the current folder's name, so it tells both where the list is and when it changed.
  private async switchFolder(folder: InboxFolder): Promise<void> {
    if (this.currentFolder === folder) return;
    const trigger = this.messagesPage.locator(this.selectors.inboxFolderTrigger).filter({ visible: true }).first();
    const label = this.folderLabel(folder);
    const showing = new RegExp(`(^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
    if (!await trigger.count()) {
      // No folder dropdown: the one list shown is the default (focused) inbox.
      if (folder === 'focused') { this.currentFolder = 'focused'; return; }
      throw new Error('Inbox folder dropdown not found');
    }
    if (showing.test(await trigger.innerText())) { this.currentFolder = folder; return; }
    await trigger.click();
    const item = this.messagesPage.locator(this.selectors.inboxFolderItem)
      .filter({ visible: true }).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
    try { await item.waitFor({ timeout: 3_000 }); }
    catch (error) {
      await this.messagesPage.keyboard.press('Escape');
      throw new Error(`No "${label}" item in the inbox folder dropdown`, { cause: error });
    }
    await item.click();
    const deadline = Date.now() + FOLDER_SWITCH_MS;
    while (!showing.test(await trigger.innerText()) && Date.now() < deadline) await delay(150);
    if (!showing.test(await trigger.innerText())) throw new Error(`Inbox did not switch to "${label}"`);
    // The list re-renders after the pill changes; give it a moment before reading cards.
    await delay(800);
    await this.messagesPage.locator(this.selectors.conversationList).first().waitFor();
    this.currentFolder = folder;
  }
  // Current UI renders conversation cards without links. A card's thread URL is learned
  // by clicking it once. The first scan of a folder reports every thread once (so history
  // can be baselined); afterwards only cards whose preview changed are reported, for a
  // bounded window that covers debouncing, so threads are not reloaded on every poll.
  private async discoverConversations(folder: InboxFolder = 'focused'): Promise<string[]> {
    const now = Date.now();
    const firstScan = !this.scannedFolders.has(folder);
    const reported = new Set<string>();
    const items = await this.messagesPage.locator(this.selectors.conversationItem).all();
    for (const item of items.slice(0, this.threadLimit)) {
      if (await item.locator(this.selectors.conversationSponsored).count()) continue;
      const names = await optionalText(item.locator(this.selectors.conversationNames));
      if (!names) continue;
      const key = hash(names);
      if ((this.cardRetryAt.get(key) ?? 0) > now) continue;
      const timeLabel = await optionalText(item.locator(this.selectors.conversationTime));
      const fingerprint = hash(JSON.stringify([names,
        await optionalText(item.locator(this.selectors.conversationSnippet)), timeLabel]));
      let id = this.knownThreads.get(key);
      if (!id) {
        try {
          if (await item.locator(this.selectors.conversationActive).count()) {
            id = threadUrl(this.messagesPage.url());
          } else {
            id = await this.switchByClick(item);
          }
        } catch {
          this.cardRetryAt.set(key, now + 120_000);
          this.log.warn({ ref: key.slice(0, 12) }, 'Conversation card could not be opened; retrying later');
          continue;
        }
        this.openThread = id;
        this.knownThreads.set(key, id);
        // LinkedIn renders cards lazily, so an old thread can surface after startup. Not after
        // an acceptance, though: that is the new connection's thread, however old its note.
        if (!firstScan && looksOld(timeLabel) && now >= this.freshUntil) this.staleLate.add(id);
      }
      // A thread moves folders when a connection is accepted; remember where it was last seen.
      this.threadFolder.set(id, folder);
      const previous = this.fingerprints.get(key);
      if (previous !== fingerprint) {
        this.fingerprints.set(key, fingerprint);
        if (firstScan) reported.add(id); else this.changedAt.set(id, now);
      }
    }
    this.scannedFolders.add(folder);
    for (const [id, at] of this.changedAt) {
      if (now - at < this.changeWindowMs) reported.add(id); else this.changedAt.delete(id);
    }
    return [...reported];
  }
  staleConversations(): ReadonlySet<string> { return this.staleLate; }
  private async lastEventUrn(): Promise<string | null> {
    const events = this.messagesPage.locator(this.selectors.message);
    const count = await events.count();
    return count ? events.nth(count - 1).getAttribute('data-event-urn') : null;
  }
  // Switches threads like a user would: clicking a card inside the loaded app, with no
  // full page load. Returns the new thread URL once the message view has really changed;
  // otherwise it throws, so a stale view of the previous thread is never read as this one.
  private async switchByClick(item: Locator, expectedPath?: string): Promise<string> {
    const before = await this.lastEventUrn();
    const previous = this.messagesPage.url();
    await item.locator(this.selectors.conversationItemLink).first().click();
    await this.messagesPage.waitForURL(url => url.href !== previous &&
      url.pathname.startsWith('/messaging/thread/') &&
      (expectedPath === undefined || url.pathname === expectedPath));
    const deadline = Date.now() + SWITCH_SETTLE_MS;
    while (before !== null && await this.lastEventUrn() === before && Date.now() < deadline) {
      await delay(150);
    }
    if (before !== null && await this.lastEventUrn() === before) {
      throw new Error('Thread view did not update after switching conversations');
    }
    return threadUrl(this.messagesPage.url());
  }
  private async openByCard(safe: string): Promise<boolean> {
    if (!this.messagesPage.url().includes('/messaging/')) return false;
    const key = [...this.knownThreads].find(([, url]) => url === safe)?.[0];
    if (!key) return false;
    const expectedPath = new URL(safe).pathname;
    // The card only exists in the folder it was seen in; switch there first (no page load).
    const folder = this.threadFolder.get(safe);
    if (folder && this.folders.includes(folder) && this.currentFolder !== folder) {
      try { await this.switchFolder(folder); } catch { return false; }
    }
    for (const item of await this.messagesPage.locator(this.selectors.conversationItem).all()) {
      const names = await optionalText(item.locator(this.selectors.conversationNames));
      if (!names || hash(names) !== key) continue;
      try {
        await this.switchByClick(item, expectedPath);
        return true;
      } catch (error) {
        if (error instanceof Error && /did not update/.test(error.message)) throw error;
        return false;
      }
    }
    return false;
  }
  private async openConversation(id: string): Promise<void> {
    const safe = threadUrl(id);
    const onThread = this.openThread === safe &&
      new URL(this.messagesPage.url()).pathname === new URL(safe).pathname;
    if (!onThread) {
      // Full navigation is only a fallback: LinkedIn rejects bursts of direct thread loads.
      if (!await this.openByCard(safe)) {
        await this.messagesPage.goto(safe, { waitUntil: 'domcontentloaded' });
      }
      this.openThread = safe;
    }
    await this.messagesPage.locator(this.selectors.thread).first().waitFor();
  }
  async thread(id: string): Promise<Thread> {
    await this.openConversation(id);
    const recipients = this.messagesPage.locator(this.selectors.recipient);
    const recipientLinks = new Set<string>();
    let nonPersonRecipient = false;
    for (const recipient of await recipients.all()) {
      const href = await recipient.getAttribute('href');
      if (!href) continue;
      const profile = tryProfileUrl(href);
      if (profile) recipientLinks.add(profile); else nonPersonRecipient = true;
    }
    const supported = recipientLinks.size === 1 && !nonPersonRecipient &&
      !await this.messagesPage.locator(this.selectors.unsupported).count();
    if (!supported) {
      this.log.warn({ ref: hash(id), recipients: recipientLinks.size, nonPersonRecipient },
        'Unsupported or unidentified thread (group/Page/InMail?); skipped');
      return { id, messages: [], supported: false };
    }
    let events = await this.messagesPage.locator(this.selectors.message).all();
    if (!events.length) events = await this.messagesPage.locator(this.selectors.messageLegacy).all();
    const messages: Message[] = [];
    let sender: string | null = null;
    const occurrences = new Map<string, number>();
    for (const event of events) {
      const text = await optionalText(event.locator(this.selectors.messageText));
      const attachment = await event.locator(this.selectors.attachment).count() > 0;
      if (!await event.locator(this.selectors.messageText).count() && !attachment) continue;
      const senderLink = event.locator(this.selectors.messageSender).first();
      const href = await senderLink.count() ? await senderLink.getAttribute('href') : null;
      if (href) {
        const profile = tryProfileUrl(href);
        if (!profile) {
          // A Page/organisation sender is never the owner and is out of scope for replies.
          this.log.warn({ ref: hash(id) }, 'Non-person sender in thread; skipped as unsupported');
          return { id, messages: [], supported: false };
        }
        sender = profile;
      }
      const [ownMarker, incomingMarker] = await event.evaluate((element, s) => [
        element.matches(s.own), element.matches(s.incoming),
      ], { own: this.selectors.messageOwn, incoming: this.selectors.messageIncoming });
      // Classification must be unambiguous; otherwise refuse to act on the thread.
      // In a verified one-to-one thread, a linked sender that is not the recipient can
      // only be the owner (LinkedIn may render the owner's link in a different URL form).
      const isRecipient = sender !== null && recipientLinks.has(sender);
      const ownByElimination = !incomingMarker && sender !== null && !isRecipient &&
        recipientLinks.size === 1;
      const own = ownMarker || (!incomingMarker && (sender === this.owner ||
        (sender !== null && this.ownerAliases.has(sender)) || ownByElimination));
      const incoming = incomingMarker || (!ownMarker && isRecipient);
      if (incomingMarker && sender !== null && this.ownerAliases.has(sender)) {
        throw new Error('Message sender cannot be classified; owner alias contradicted by incoming marker');
      }
      if (own === incoming) {
        // Boolean signals only; no content or identifiers.
        throw new Error('Message sender cannot be classified; refusing automatic reply ' +
          `[href=${href !== null} matchesOwner=${sender === this.owner} ownMarker=${ownMarker} ` +
          `incomingMarker=${incomingMarker} matchesRecipient=${isRecipient}]`);
      }
      if (own && sender !== null && sender !== this.owner && !this.ownerAliases.has(sender)) {
        this.ownerAliases.add(sender);
        this.log.info({ ref: hash(id), idForm: /\/in\/ACo/i.test(sender) ? 'member-id' : 'other' },
          'Owner profile link form differs from OWNER_PROFILE_URL; alias learned from one-to-one thread');
      }
      if (own) sender = this.owner;
      const time = event.locator(this.selectors.messageTime).first();
      const absoluteTime = await time.count() ? await time.getAttribute('datetime') : null;
      const raw = absoluteTime ?? (await time.count() ? await time.innerText() : null);
      const stableId = await event.getAttribute('data-event-urn') ?? await event.getAttribute('data-message-id');
      const occurrenceKey = hash(JSON.stringify([own, text, absoluteTime]));
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
  // The composer's own form, so a button elsewhere on the page is never mistaken for Send.
  private composerScope(composer: Locator): Locator {
    return composer.locator('xpath=ancestor::form[1]');
  }
  private async scopeFor(composer: Locator): Promise<Locator | Page> {
    const form = this.composerScope(composer);
    return await form.count() ? form : this.messagesPage;
  }
  async send(id: string, text: string, beforeClick: () => void): Promise<void> {
    await this.openConversation(id);
    if (!await this.authenticated()) throw new Error('Authentication required');
    const composer = this.messagesPage.locator(this.selectors.composer).first();
    if ((await composer.innerText()).trim()) {
      throw new Error('Existing composer draft found; refusing to overwrite or send it');
    }
    const scope = await this.scopeFor(composer);
    const send = scope.locator(this.selectors.send).filter({ visible: true }).first();
    try {
      // Real keystrokes, like a person typing: LinkedIn may only reveal Send for those.
      await composer.click();
      await composer.pressSequentially(text, { delay: TYPING_DELAY_MS, timeout: 30_000 });
      if (normalized(await composer.innerText()) !== normalized(text)) {
        throw new Error('Composer text does not match the reply; refusing to send');
      }
      try { await send.waitFor({ timeout: 5_000 }); }
      catch (error) {
        throw new Error(`Send button not visible after typing (${await describeControls(scope)})`,
          { cause: error });
      }
      // LinkedIn renders Send at all times and enables it shortly after typing, so the
      // click check (which waits for the button to be enabled) must come before any decision.
      // It runs every actionability check without clicking, so only a real click attempt
      // is recorded as dispatched.
      try { await send.click({ trial: true, timeout: 5_000 }); }
      catch (error) {
        throw new Error(`Send button is not clickable (${await describeLocator(send)}${blockedBy(error)})`,
          { cause: error });
      }
      beforeClick();
      await send.click({ timeout: 5_000 });
    } catch (error) {
      // Clear only what the bot typed (all of it or a prefix). Never clear user-authored edits.
      if (!this.messagesPage.isClosed()) {
        const current = normalized(await composer.innerText());
        if (current !== '' && normalized(text).startsWith(current)) await composer.fill('');
      }
      throw error;
    }
  }
  // Read-only diagnosis of the Send control: types one character, records which buttons the
  // composer form shows, then removes it. It never clicks Send (trial clicks only run checks).
  async probeSend(): Promise<SendProbe> {
    if (!new URL(this.messagesPage.url()).pathname.startsWith('/messaging/thread/')) {
      throw new Error('No conversation is open: open one in the browser first');
    }
    const composer = this.messagesPage.locator(this.selectors.composer).first();
    if (!await composer.count()) throw new Error('Composer not found with the composer selector');
    if ((await composer.innerText()).trim()) {
      throw new Error('The composer already contains text; clear it first. The probe never overwrites a draft');
    }
    const scope = await this.scopeFor(composer);
    const send = scope.locator(this.selectors.send).filter({ visible: true }).first();
    const probe: SendProbe = {
      generatedAt: new Date().toISOString(), sendSelector: this.selectors.send,
      composerInForm: await this.composerScope(composer).count() > 0,
      controlsBefore: await sendControls(scope), controlsAfterTyping: [],
      sendVisible: false, sendEnabled: null, sendClickable: null, composerCleared: false,
    };
    try {
      await composer.click();
      await composer.pressSequentially('.', { delay: TYPING_DELAY_MS, timeout: 10_000 });
      await delay(1_500);
      probe.controlsAfterTyping = await sendControls(scope);
      probe.sendVisible = await send.waitFor({ timeout: 5_000 }).then(() => true, () => false);
      if (probe.sendVisible) {
        probe.sendEnabled = await send.isEnabled();
        probe.sendClickable = await send.click({ trial: true, timeout: 5_000 }).then(() => true, () => false);
      }
    } finally {
      try {
        if (normalized(await composer.innerText()) === '.') await composer.fill('');
        probe.composerCleared = (await composer.innerText()).trim() === '';
      } catch { /* page closed: the result below still reports composerCleared=false */ }
    }
    return probe;
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

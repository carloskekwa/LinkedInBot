import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import type { Logger } from 'pino';
import type { Config } from './config.js';

const origin = 'https://www.linkedin.com';

// Structural census only: tag/class/role/data-attribute names. No text, no profile slugs.
async function census(page: Page, pattern: string): Promise<unknown> {
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const groups = new Map<string, { count: number; roles: Set<string>; data: Set<string>;
      editable: boolean; visible: boolean; hasTime: boolean }>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const classes = typeof el.className === 'string' ? el.className.trim() : '';
      if (!re.test(classes) && !re.test(el.tagName)) continue;
      const key = `${el.tagName.toLowerCase()}.${classes.split(/\s+/).slice(0, 6).join('.')}`;
      const g = groups.get(key) ?? { count: 0, roles: new Set(), data: new Set(),
        editable: false, visible: false, hasTime: false };
      g.count++;
      const role = el.getAttribute('role'); if (role) g.roles.add(role);
      for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) g.data.add(a.name);
      if (el.isContentEditable) g.editable = true;
      if (el.getClientRects().length) g.visible = true;
      if (el.querySelector('time')) g.hasTime = true;
      groups.set(key, g);
    }
    return Array.from(groups.entries()).slice(0, 250).map(([key, g]) => ({
      key, count: g.count, roles: [...g.roles], data: [...g.data],
      editable: g.editable, visible: g.visible, hasTime: g.hasTime,
    }));
  }, pattern);
}
async function probes(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const redact = (href: string) => {
      try {
        const p = new URL(href, location.origin).pathname;
        return p.replace(/\/in\/[^/]+/, '/in/<redacted>')
          .replace(/\/messaging\/thread\/[^/]+/, '/messaging/thread/<redacted>');
      } catch { return '<invalid>'; }
    };
    const linkPaths = new Map<string, number>();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const p = redact(a.getAttribute('href') ?? '');
      linkPaths.set(p, (linkPaths.get(p) ?? 0) + 1);
    }
    const buttonLabels = new Map<string, number>();
    for (const b of Array.from(document.querySelectorAll('button,[role="button"]'))) {
      const label = (b.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').slice(0, 40);
      const cls = (typeof (b as HTMLElement).className === 'string'
        ? (b as HTMLElement).className : '').split(/\s+/).slice(0, 3).join('.');
      const key = `${label || '(no aria-label)'} | ${cls}`;
      buttonLabels.set(key, (buttonLabels.get(key) ?? 0) + 1);
    }
    return {
      path: location.pathname.replace(/\/messaging\/thread\/[^/]+/, '/messaging/thread/<redacted>'),
      title: document.title.length,
      linkPaths: [...linkPaths.entries()].filter(([p]) =>
        /messaging|mynetwork|\/in\//.test(p)).slice(0, 60),
      buttons: [...buttonLabels.entries()].slice(0, 80),
      contentEditable: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(e =>
        ({ tag: e.tagName, classes: (e as HTMLElement).className.toString().slice(0, 200),
          role: e.getAttribute('role'), ariaLabel: (e.getAttribute('aria-label') ?? '').slice(0, 40) })),
      timeElements: {
        total: document.querySelectorAll('time').length,
        withDatetime: document.querySelectorAll('time[datetime]').length,
        sampleParentClasses: Array.from(document.querySelectorAll('time')).slice(0, 5).map(t =>
          (t.parentElement?.className ?? '').toString().slice(0, 150)),
      },
      listItems: Array.from(document.querySelectorAll('main li, [role="list"] > *, [role="listitem"]'))
        .slice(0, 40).map(li => ({ tag: li.tagName,
          classes: (li as HTMLElement).className.toString().split(/\s+/).slice(0, 5).join(' '),
          role: li.getAttribute('role'),
          data: Array.from(li.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name),
          hasProfileLink: !!li.querySelector('a[href*="/in/"]'),
          hasThreadLink: !!li.querySelector('a[href*="/messaging/thread/"]'),
          hasTime: !!li.querySelector('time'), hasButton: !!li.querySelector('button') })),
    };
  });
}
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await delay(2_500);
}
export async function inspectLive(config: Config, log: Logger, signal: AbortSignal): Promise<void> {
  const context = await chromium.launchPersistentContext(config.BROWSER_PROFILE, {
    headless: false, viewport: { width: 1280, height: 900 },
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const out: Record<string, unknown> = { generatedAt: new Date().toISOString(),
      note: 'Structural DOM census only. No message text or profile slugs are recorded.' };

    await page.goto(`${origin}/messaging/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    signal.throwIfAborted();
    if (/\/(login|checkpoint|authwall)/.test(new URL(page.url()).pathname)) {
      throw new Error('Not authenticated; run npm run login first');
    }
    out['messagingList'] = { probes: await probes(page),
      census: await census(page, 'msg|conversation|thread|message|compose|inbox|mailbox') };

    const thread = page.locator('a[href*="/messaging/thread/"]').first();
    if (await thread.count()) {
      await thread.click();
      await settle(page);
      out['messagingThread'] = { probes: await probes(page),
        census: await census(page, 'msg|conversation|thread|message|compose|event|bubble|form') };
    } else {
      out['messagingThread'] = 'no thread link found with a[href*="/messaging/thread/"]';
    }

    await page.goto(`${origin}/mynetwork/invitation-manager/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    out['invitations'] = { probes: await probes(page),
      census: await census(page, 'invit|mn-|network|card|pending|accept') };

    const dir = resolve(config.DATA_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'dom-inspection.json');
    writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    log.info({ file }, 'Read-only DOM inspection written (gitignored). No actions were taken');
  } finally {
    await context.close();
  }
}

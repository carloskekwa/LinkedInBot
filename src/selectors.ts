import { readFileSync } from 'node:fs';
import { z } from 'zod';

// LinkedIn changes its DOM. These selectors require a live smoke check.
export const defaults = {
  nav: '.global-nav, nav:has(a[href*="/feed"]):has(a[href*="/messaging"]), [role="navigation"]:has(a[href*="/feed"]):has(a[href*="/messaging"])',
  me: '.global-nav__me',
  ownerProfile: '.global-nav__me-content a[href*="/in/"], .global-nav a[href*="/in/"]',
  invitationList: '.invitation-manager, .mn-invitation-manager, .mn-invitations-preview',
  invitationCard: '.invitation-card, .mn-invitation',
  invitationProfile: 'a[href*="/in/"]',
  invitationTime: 'time, .invitation-card__time-badge',
  invitationAccept: 'button[aria-label*="Accept"], button:has-text("Accept")',
  invitationsEmpty: '.invitation-manager__no-invites, .mn-invitation-manager__no-invites',
  conversationList: '.msg-conversations-container, .msg-conversation-list',
  conversationLink: 'a[href*="/messaging/thread/"]',
  thread: '.msg-s-message-list, .msg-s-message-list-container',
  message: '.msg-s-message-list__event',
  messageText: '.msg-s-event-listitem__body',
  messageSender: '.msg-s-message-group__profile-link',
  messageOwn: '.msg-s-message-list__event--own, .msg-s-message-list__event--self',
  messageTime: 'time[datetime], time, .msg-s-message-group__timestamp',
  messagePending: '.msg-s-message-list__event--pending, .msg-s-message-list__event--error, .msg-s-event-listitem__error',
  attachment: '.msg-s-event-listitem__attachment, .msg-s-event-listitem__image-container',
  recipient: '.msg-thread__link-to-profile',
  unsupported: '.msg-thread__group-conversation, .msg-thread__inmail',
  composer: '.msg-form__contenteditable[contenteditable="true"]',
  send: 'button.msg-form__send-button',
  profileMore: 'button[aria-label="More actions"], button:has-text("More")',
  removeConnection: '[role="menuitem"]:has-text("Remove connection"), .artdeco-dropdown__item:has-text("Remove connection")',
};
export type Selectors = typeof defaults;
const overrideSchema = z.object(Object.fromEntries(
  Object.keys(defaults).map(key => [key, z.string().min(1).optional()]),
)).strict();
export function loadSelectors(path: string): Selectors {
  if (!path) return { ...defaults };
  const overrides = overrideSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Selectors)[]) {
    const value = overrides[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

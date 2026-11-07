import { readFileSync } from 'node:fs';
import { z } from 'zod';

// LinkedIn changes its DOM. These selectors require a live smoke check.
// Current defaults were derived from a structural inspection (npm run inspect:live) in Nov 2026.
export const defaults = {
  nav: '.global-nav, nav:has(a[href*="/messaging"]), [role="navigation"]:has(a[href*="/messaging"])',
  me: '.global-nav__me',
  ownerProfile: '.global-nav__me-content a[href*="/in/"], .global-nav a[href*="/in/"]',
  // Invitation manager uses obfuscated classes; rely on roles and aria-labels.
  invitationList: 'main [role="list"], main [role="listitem"], .invitation-manager, .mn-invitation-manager, .mn-invitations-preview',
  invitationCard: 'main [role="listitem"], .invitation-card, .mn-invitation',
  invitationProfile: 'a[href*="/in/"]',
  invitationTime: 'time, .invitation-card__time-badge',
  invitationAccept: 'button[aria-label^="Accept"], button:has-text("Accept")',
  invitationsEmpty: '.invitation-manager__no-invites, .mn-invitation-manager__no-invites',
  conversationList: '.msg-conversations-container__conversations-list, .msg-conversations-container, .msg-conversation-list',
  conversationLink: 'a[href*="/messaging/thread/"]',
  conversationItem: 'li.msg-conversation-listitem',
  conversationItemLink: '.msg-conversation-listitem__link',
  conversationActive: '.msg-conversation-listitem__active-text',
  conversationNames: '.msg-conversation-listitem__participant-names',
  conversationSnippet: '.msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet--v2',
  conversationTime: '.msg-conversation-card__time-stamp',
  conversationSponsored: '[data-js-sponsored-conversation-hoverable-trigger]',
  thread: '.msg-s-message-list-content, .msg-s-message-list, .msg-s-message-list-container',
  message: '.msg-s-event-listitem[data-event-urn]',
  messageLegacy: '.msg-s-message-list__event',
  messageText: '.msg-s-event-listitem__body',
  messageSender: 'a.msg-s-event-listitem__link[href*="/in/"], a.msg-s-message-group__profile-link[href*="/in/"]',
  messageOwn: '.msg-s-message-list__event--own, .msg-s-message-list__event--self, .msg-s-event-listitem--own',
  messageIncoming: '.msg-s-event-listitem--other',
  messageTime: 'time[datetime], time, .msg-s-message-group__timestamp',
  messagePending: '.msg-s-message-list__event--pending, .msg-s-message-list__event--error, .msg-s-event-listitem__error',
  attachment: '.msg-s-event-listitem__attachment, .msg-s-event-listitem__image-container, .msg-s-event-listitem__file-attachment, .msg-s-event-listitem__content-preview-container',
  recipient: '.msg-thread__link-to-profile',
  unsupported: '.msg-thread__group-conversation, .msg-thread__inmail',
  composer: '.msg-form__contenteditable[contenteditable="true"], [role="textbox"][contenteditable="true"]',
  // The Send button is only rendered once the composer has content.
  send: 'button.msg-form__send-button, form.msg-form button[type="submit"]:not(.msg-form__send-toggle)',
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

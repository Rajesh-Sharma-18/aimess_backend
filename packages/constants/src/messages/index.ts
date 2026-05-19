import { AUTH_MESSAGES } from "./auth.messages.js";
import { COMMON_MESSAGES } from "./common.messages.js";
import { USER_MESSAGES } from "./user.messages.js";
import type { MessageCatalog } from "./types.js";

/**
 * Merged API message catalog. Add domain files under `messages/` and spread here.
 *
 * @example
 * // messages/user.messages.ts
 * export const USER_MESSAGES = { ... } as const satisfies MessageCatalog;
 *
 * // messages/index.ts
 * export const MESSAGES = { ...AUTH_MESSAGES, ...USER_MESSAGES, ...COMMON_MESSAGES };
 */
export const MESSAGES = {
  ...AUTH_MESSAGES,
  ...USER_MESSAGES,
  ...COMMON_MESSAGES,
} as const satisfies MessageCatalog;

export type MessageKey = keyof typeof MESSAGES;

export { AUTH_MESSAGES, type AuthMessageKey } from "./auth.messages.js";
export { COMMON_MESSAGES, type CommonMessageKey } from "./common.messages.js";
export { USER_MESSAGES, type UserMessageKey } from "./user.messages.js";
export type { LocalizedText, MessageCatalog } from "./types.js";

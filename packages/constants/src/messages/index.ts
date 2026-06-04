import { ADMIN_MESSAGES } from "./admin.messages.js";
import { AUTH_MESSAGES } from "./auth.messages.js";
import { CHAT_MESSAGES } from "./chat.messages.js";
import { COMMON_MESSAGES } from "./common.messages.js";
import { COMMUNITY_MESSAGES } from "./community.messages.js";
import { UPLOAD_MESSAGES } from "./upload.messages.js";
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
  ...COMMUNITY_MESSAGES,
  ...CHAT_MESSAGES,
  ...UPLOAD_MESSAGES,
  ...ADMIN_MESSAGES,
  ...COMMON_MESSAGES,
} as const satisfies MessageCatalog;

export type MessageKey = keyof typeof MESSAGES;

export { ADMIN_MESSAGES, type AdminMessageKey } from "./admin.messages.js";
export { AUTH_MESSAGES, type AuthMessageKey } from "./auth.messages.js";
export { CHAT_MESSAGES, type ChatMessageKey } from "./chat.messages.js";
export { COMMON_MESSAGES, type CommonMessageKey } from "./common.messages.js";
export {
  COMMUNITY_MESSAGES,
  type CommunityMessageKey,
} from "./community.messages.js";
export { UPLOAD_MESSAGES, type UploadMessageKey } from "./upload.messages.js";
export { USER_MESSAGES, type UserMessageKey } from "./user.messages.js";
export type { LocalizedText, MessageCatalog } from "./types.js";

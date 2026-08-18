/**
 * THE canonical socket event vocabulary — one set of names for private, group and community.
 *
 * Surface is carried by the NAMESPACE (`/chat` vs `/community`), never by the event name, so a
 * client writes one dispatcher instead of a per-surface name map. This replaces the previous split
 * where community prefixed everything `community:` and private/group prefixed nothing.
 *
 * Two rules make the set collision-free and predictable:
 *  1. **Client→server is imperative** (`message:delete`), **server→client is past tense**
 *     (`message:deleted`). Previously `/chat` used the SAME string for both directions on delete,
 *     read and delivered — so a client that re-emitted what it received self-looped.
 *  2. **Colons only.** The dot-separated `friend.*` and `community.member.*` islands are gone.
 */

/** Client → server. Imperative: the client is asking for something to happen. */
export const SOCKET_IN = {
  ROOM_JOIN: "room:join",
  ROOM_LEAVE: "room:leave",

  /**
   * Retarget this connection's display language: `{ lang: "th" }`.
   *
   * The handshake seeds the locale, but a connection outlives a Settings →
   * Language change and a browser cannot rewrite handshake headers on a live
   * websocket. Without this the user had to reconnect before live SYSTEM
   * messages followed the language they had just picked. Accepted on every
   * namespace (see `scopeSocketLocale`); unsupported values are ignored.
   */
  LOCALE_SET: "locale:set",

  MESSAGE_SEND: "message:send",
  MESSAGE_EDIT: "message:edit",
  MESSAGE_DELETE: "message:delete",
  MESSAGE_REACT: "message:react",
  MESSAGE_FORWARD: "message:forward",
  MESSAGE_PIN: "message:pin",
  MESSAGE_UNPIN: "message:unpin",
  MESSAGE_READ: "message:read",
  MESSAGE_DELIVERED: "message:delivered",
  MESSAGE_REACTIONS_GET: "message:reactions:get",

  MESSAGES_FETCH: "messages:fetch",
  MESSAGES_CATCHUP: "messages:catchup",

  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  RECORDING_START: "recording:start",
  RECORDING_STOP: "recording:stop",

  PRESENCE_HEARTBEAT: "presence:heartbeat",
  PRESENCE_SUBSCRIBE: "presence:subscribe",
  PRESENCE_UNSUBSCRIBE: "presence:unsubscribe",
  PRESENCE_UNSUBSCRIBE_ALL: "presence:unsubscribe:all",
  PRESENCE_LIST: "presence:list",

  CALL_INITIATE: "call:initiate",
  CALL_ANSWER: "call:answer",
  CALL_DECLINE: "call:decline",
  CALL_END: "call:end",

  FRIEND_REQUEST: "friend:request",
  FRIEND_ACCEPT: "friend:accept",
  FRIEND_REJECT: "friend:reject",
  FRIEND_REMOVE: "friend:remove",
  FRIEND_CANCEL: "friend:cancel",

  MEMBER_KICK: "member:kick",
  MEMBER_BAN: "member:ban",
  MEMBER_UNBAN: "member:unban",
  MEMBER_ROLE_CHANGE: "member:role:change",
  ADMIN_TRANSFER: "admin:transfer",
  REPORT_CREATE: "report:create",
  ROOM_DELETE: "room:delete",
} as const;

/** Server → client. Past tense: something already happened. */
export const SOCKET_OUT = {
  MESSAGE_NEW: "message:new",
  MESSAGE_EDITED: "message:edited",
  MESSAGE_DELETED: "message:deleted",
  MESSAGE_REACTION: "message:reaction",
  MESSAGE_READ: "message:read:updated",
  MESSAGE_DELIVERED: "message:delivered:updated",
  MESSAGE_PINNED: "message:pinned",
  MESSAGE_UNPINNED: "message:unpinned",
  /** Own-device read fan-out. Was the only snake_case name in the system (`read_sync`). */
  READ_SYNCED: "read:synced",

  MESSAGES_CATCHUP_RESULT: "messages:catchup:result",

  ROOM_CREATED: "room:created",
  ROOM_UPDATED: "room:updated",
  ROOM_DELETED: "room:deleted",
  ROOM_ARCHIVED: "room:archived",
  ROOM_UNARCHIVED: "room:unarchived",
  ROOM_CLOSED: "room:closed",
  ROOM_REOPENED: "room:reopened",

  MEMBER_ADDED: "member:added",
  MEMBER_JOINED: "member:joined",
  MEMBER_UPDATED: "member:updated",
  MEMBER_REMOVED: "member:removed",
  MEMBER_MUTED: "member:muted",
  MEMBER_UNMUTED: "member:unmuted",
  MEMBER_UNBANNED: "member:unbanned",
  MEMBERSHIP_RESTRICTED: "membership:restricted",

  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  RECORDING_START: "recording:start",
  RECORDING_STOP: "recording:stop",

  PRESENCE_STATUS: "presence:status",

  CALL_INCOMING: "call:incoming",
  CALL_ANSWERED: "call:answered",
  CALL_DECLINED: "call:declined",
  CALL_HANDLED: "call:handled",
  CALL_CANCELLED: "call:cancelled",
  CALL_ENDED: "call:ended",
  CALL_MISSED: "call:missed",
  CALL_OUTGOING_MIRROR: "call:outgoing_mirror",
} as const;

export type SocketInEvent = (typeof SOCKET_IN)[keyof typeof SOCKET_IN];
export type SocketOutEvent = (typeof SOCKET_OUT)[keyof typeof SOCKET_OUT];

/**
 * Canonical payload field names. Before this, the same "who did it" concept was spelled seven
 * different ways across events (`senderId`, `userId`, `readerId`, `recipientId`, `deletedBy`,
 * `pinnedBy`, `senderUserId`) and the room was `roomId` / `conversationId` / `communityId`.
 *
 * Every server→client payload now uses:
 *  - `roomId`   — the one room identifier, on every surface
 *  - `actorId`  — who caused the event (sender, reader, deleter, pinner, …)
 *  - `messageId`— the server message id
 *  - `serverTs` — epoch MILLISECONDS, never an ISO string
 *  - `revision` / `sequenceNumber` — the two sync axes, on every surface
 */
export const CANONICAL_PAYLOAD_KEYS = [
  "roomId",
  "actorId",
  "messageId",
  "serverTs",
  "revision",
  "sequenceNumber",
] as const;

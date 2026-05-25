/** Socket.IO event name constants — matches the reference JS chat-service exactly. */

// === Private messaging ===
export const PRIVATE_PREFIX = "room:private";
export const PRIVATE_HOME_LOBBY = "room:private:home";

export const PRIVATE_EVENTS = {
  // Home / conversation list
  HOME_JOIN: `${PRIVATE_HOME_LOBBY}:join`,
  HOME_LEAVE: `${PRIVATE_HOME_LOBBY}:leave`,
  HOME_CONVERSATIONS_LOAD_MORE: `${PRIVATE_HOME_LOBBY}:conversations:load-more`,

  // Initiation (join personal channel on app start)
  INITIATION_JOIN: `${PRIVATE_PREFIX}:initiation:join`,

  // Room
  USER_JOIN: `${PRIVATE_PREFIX}:user:join`,
  MESSAGES_LOAD_MORE: `${PRIVATE_PREFIX}:messages:load-more`,

  // Message actions
  MESSAGE_ADD: `${PRIVATE_PREFIX}:message:add`,
  MESSAGE_REACT: `${PRIVATE_PREFIX}:message:react`,
  MESSAGE_PIN: `${PRIVATE_PREFIX}:message:pin`,
  MESSAGE_UNPIN: `${PRIVATE_PREFIX}:message:unpin`,

  // Read receipts
  CONVERSATION_READ: `${PRIVATE_PREFIX}:conversation:read`,

  // Presence
  PRESENCE_HEARTBEAT: `${PRIVATE_PREFIX}:presence:heartbeat`,
  PRESENCE_APP_STATE: `${PRIVATE_PREFIX}:presence:app_state`,
  PRESENCE_SUBSCRIBE: `${PRIVATE_PREFIX}:presence:subscribe`,
  PRESENCE_UNSUBSCRIBE: `${PRIVATE_PREFIX}:presence:unsubscribe`,
} as const;

// === Emitted events (server → client) ===
export const PRIVATE_EMIT = {
  MESSAGE_ADD_NEW: (roomId: string) =>
    `${PRIVATE_PREFIX}:${roomId}:message:add:new`,
  MESSAGE_REACT_NEW: `${PRIVATE_PREFIX}:message:react:new`,
  MESSAGE_PIN_NEW: (roomId: string) =>
    `${PRIVATE_PREFIX}:${roomId}:message:pin:new`,
  MESSAGE_READ: (roomId: string) => `${PRIVATE_PREFIX}:${roomId}:message:read`,
  CONVERSATION_READ_UPDATED: `${PRIVATE_HOME_LOBBY}:conversation:read:updated`,
} as const;

// === Community / General room ===
export const GENERAL_PREFIX = "room:general";
export const GENERAL_HOME_LOBBY = "room:general:home";

export const GENERAL_EVENTS = {
  HOME_JOIN: `${GENERAL_HOME_LOBBY}:join`,
  HOME_LEAVE: `${GENERAL_HOME_LOBBY}:leave`,

  USER_JOIN: `${GENERAL_PREFIX}:user:join`,
  MESSAGES_LOAD_MORE: `${GENERAL_PREFIX}:messages:load-more`,

  MESSAGE_ADD: `${GENERAL_PREFIX}:message:add`,
  MESSAGE_REACT: `${GENERAL_PREFIX}:message:react`,
  MESSAGE_REPORT: `${GENERAL_PREFIX}:message:report`,
} as const;

export const GENERAL_EMIT = {
  MESSAGE_ADD_NEW: (roomId: string) =>
    `${GENERAL_PREFIX}:${roomId}:message:add:new`,
  MESSAGE_REACT_NEW: `${GENERAL_PREFIX}:message:react:new`,
  NOTIFY_JOIN: `${GENERAL_PREFIX}:nofify:join`,
  STATE_UPDATE: `${GENERAL_PREFIX}:state:update`,
} as const;

// === Group chat ===
export const GROUP_PREFIX = "room:group";
export const GROUP_HOME_LOBBY = "room:group:home";

export const GROUP_EVENTS = {
  HOME_JOIN: `${GROUP_HOME_LOBBY}:join`,
  HOME_LEAVE: `${GROUP_HOME_LOBBY}:leave`,
  HOME_LOAD_MORE: `${GROUP_HOME_LOBBY}:conversations:load-more`,

  USER_JOIN: `${GROUP_PREFIX}:user:join`,
  MESSAGES_LOAD_MORE: `${GROUP_PREFIX}:messages:load-more`,

  MESSAGE_ADD: `${GROUP_PREFIX}:message:add`,
  MESSAGE_REACT: `${GROUP_PREFIX}:message:react`,
  MESSAGE_PIN: `${GROUP_PREFIX}:message:pin`,
  MESSAGE_UNPIN: `${GROUP_PREFIX}:message:unpin`,
  MESSAGE_DELETE: `${GROUP_PREFIX}:message:delete`,

  CONVERSATION_READ: `${GROUP_PREFIX}:conversation:read`,
} as const;

export const GROUP_EMIT = {
  MESSAGE_ADD_NEW: (roomId: string) =>
    `${GROUP_PREFIX}:${roomId}:message:add:new`,
  MESSAGE_REACT_NEW: `${GROUP_PREFIX}:message:react:new`,
  MESSAGE_PIN_NEW: (roomId: string) =>
    `${GROUP_PREFIX}:${roomId}:message:pin:new`,
  MESSAGE_DELETE_NEW: (roomId: string) =>
    `${GROUP_PREFIX}:${roomId}:message:delete:new`,
  CONVERSATION_READ_UPDATED: `${GROUP_HOME_LOBBY}:conversation:read:updated`,
} as const;

// === Livestream ===
export const LIVESTREAM_PREFIX = "room:livestream";

export const LIVESTREAM_EVENTS = {
  JOIN: `${LIVESTREAM_PREFIX}:join`,
  LEAVE: `${LIVESTREAM_PREFIX}:leave`,
  COMMENT_ADD: `${LIVESTREAM_PREFIX}:comment:add`,
  COMMENTS_LOAD_MORE: `${LIVESTREAM_PREFIX}:comments:load-more`,
} as const;

export const LIVESTREAM_EMIT = {
  COMMENT_NEW: (livestreamId: string) =>
    `${LIVESTREAM_PREFIX}:${livestreamId}:comment:new`,
} as const;

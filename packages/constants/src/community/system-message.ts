export const CommunitySystemMessageType = {
  COMMUNITY_CREATED: "COMMUNITY_CREATED",
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",
  MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
  COMMUNITY_JOINED: "COMMUNITY_JOINED",
} as const;

/**
 * Visibility scope for system messages. PERSONAL messages are only visible to
 * a specific user (e.g., "You joined this community"), while COMMUNITY messages
 * are visible to all members in the room.
 */
export const CommunitySystemMessageVisibility = {
  PERSONAL: "PERSONAL",
  COMMUNITY: "COMMUNITY",
} as const;

export type CommunitySystemMessageVisibility =
  (typeof CommunitySystemMessageVisibility)[keyof typeof CommunitySystemMessageVisibility];

export type CommunitySystemMessageType =
  (typeof CommunitySystemMessageType)[keyof typeof CommunitySystemMessageType];

/**
 * Canonical changed-field tokens sent in `CommunityUpdatedMetadata.changedFields`.
 * One system message is emitted per field (Telegram-style), so each message
 * always has exactly one item in changedFields.
 */
export const CommunityChangedField = {
  AVATAR: "avatar",
  NAME: "name",
  DESCRIPTION: "description",
  VISIBILITY: "visibility",
  HANDLE: "handle",
  CATEGORY: "category",
  RULES: "rules",
  BANNER: "banner",
} as const;

export type CommunityChangedField =
  (typeof CommunityChangedField)[keyof typeof CommunityChangedField];

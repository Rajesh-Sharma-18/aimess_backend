export const CommunitySystemMessageType = {
  COMMUNITY_CREATED: "COMMUNITY_CREATED",
  COMMUNITY_UPDATED: "COMMUNITY_UPDATED",
  MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
} as const;

export type CommunitySystemMessageType =
  (typeof CommunitySystemMessageType)[keyof typeof CommunitySystemMessageType];

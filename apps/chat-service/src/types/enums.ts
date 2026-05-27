/** Message types for private and group chat */
export const MessageType = {
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  DOCUMENT: "DOCUMENT",
  VIDEO: "VIDEO",
  SYSTEM: "SYSTEM",
  LOCATION: "LOCATION",
  CONTACT: "CONTACT",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Message types for community/general rooms */
export const CommunityMessageType = {
  TEXT: "text",
  IMAGE: "image",
  VOICE: "voice",
  CUSTOM: "custom",
  LOCATION: "location",
  CONTACT: "contact",
} as const;
export type CommunityMessageType =
  (typeof CommunityMessageType)[keyof typeof CommunityMessageType];

/** Group member roles */
export const GroupRole = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MODERATOR: "MODERATOR",
  MEMBER: "MEMBER",
} as const;
export type GroupRole = (typeof GroupRole)[keyof typeof GroupRole];

/** Group member status */
export const GroupMemberStatus = {
  ACTIVE: "ACTIVE",
  LEFT: "LEFT",
  KICKED: "KICKED",
  BANNED: "BANNED",
} as const;
export type GroupMemberStatus =
  (typeof GroupMemberStatus)[keyof typeof GroupMemberStatus];

/** Friendship status */
export const FriendshipStatus = {
  ACCEPTED: "ACCEPTED",
  PENDING: "PENDING",
  REJECTED: "REJECTED",
  DECLINED: "DECLINED",
} as const;
export type FriendshipStatus =
  (typeof FriendshipStatus)[keyof typeof FriendshipStatus];

/** Group room type */
export const GroupRoomType = {
  GROUP: "GROUP",
  COMMUNITY: "COMMUNITY",
} as const;
export type GroupRoomType = (typeof GroupRoomType)[keyof typeof GroupRoomType];

/** Group room status */
export const GroupRoomStatus = {
  ACTIVE: "ACTIVE",
  DISBANDED: "DISBANDED",
} as const;
export type GroupRoomStatus =
  (typeof GroupRoomStatus)[keyof typeof GroupRoomStatus];

/** Invite link status */
export const InviteLinkStatus = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
} as const;
export type InviteLinkStatus =
  (typeof InviteLinkStatus)[keyof typeof InviteLinkStatus];

/** System events for private/group messages */
export const SystemEvent = {
  GROUP_CREATED: "GROUP_CREATED",

  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_LEFT: "MEMBER_LEFT",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MEMBER_ADDED: "MEMBER_ADDED",

  ROOM_RENAMED: "ROOM_RENAMED",
  ROLE_CHANGED: "ROLE_CHANGED",
  AVATAR_CHANGED: "AVATAR_CHANGED",

  ADMIN_ASSIGNED: "ADMIN_ASSIGNED",
  ADMIN_REMOVED: "ADMIN_REMOVED",

  DESCRIPTION_CHANGED: "DESCRIPTION_CHANGED",

  INVITE_LINK_CREATED: "INVITE_LINK_CREATED",

  CALL_STARTED: "CALL_STARTED",
  CALL_ENDED: "CALL_ENDED",

  MESSAGE_PINNED: "MESSAGE_PINNED",
  MESSAGE_UNPINNED: "MESSAGE_UNPINNED",

  MESSAGES_ENCRYPTED: "MESSAGES_ENCRYPTED",
} as const;
export type SystemEvent = (typeof SystemEvent)[keyof typeof SystemEvent];

/** Deleted type for group messages */
export const DeletedType = {
  SELF_DELETE: "SELF_DELETE",
  ADMIN_DELETE: "ADMIN_DELETE",
} as const;
export type DeletedType = (typeof DeletedType)[keyof typeof DeletedType];

/** Room membership status for community rooms */
export const RoomMemberStatus = {
  ACTIVE: "active",
  MUTED: "muted",
  BANNED: "banned",
} as const;
export type RoomMemberStatus =
  (typeof RoomMemberStatus)[keyof typeof RoomMemberStatus];

/** Room membership roles */
export const RoomMemberRole = {
  OWNER: "owner",
  ADMIN: "admin",
  MODERATOR: "moderator",
  MEMBER: "member",
} as const;
export type RoomMemberRole =
  (typeof RoomMemberRole)[keyof typeof RoomMemberRole];

/** General room status */
export const GeneralRoomStatus = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  REMOVED: "removed",
} as const;
export type GeneralRoomStatus =
  (typeof GeneralRoomStatus)[keyof typeof GeneralRoomStatus];

/** Livestream status */
export const LivestreamStatus = {
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  ENDED: "ENDED",
  CANCELED: "CANCELED",
} as const;
export type LivestreamStatus =
  (typeof LivestreamStatus)[keyof typeof LivestreamStatus];

/** Livestream platform */
export const LivestreamPlatform = {
  YOUTUBE: "YOUTUBE",
  FACEBOOK: "FACEBOOK",
  XOILAC: "XOILAC",
  CUSTOM: "CUSTOM",
} as const;
export type LivestreamPlatform =
  (typeof LivestreamPlatform)[keyof typeof LivestreamPlatform];

/** Livestream server status */
export const LivestreamServerStatus = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;
export type LivestreamServerStatus =
  (typeof LivestreamServerStatus)[keyof typeof LivestreamServerStatus];

/** Ban type for room members */
export const BanType = {
  PERMANENT: "PERMANENT",
  TEMP: "TEMP",
} as const;
export type BanType = (typeof BanType)[keyof typeof BanType];

/** Ban source */
export const BanSource = {
  APP: "APP",
  BO: "BO",
  SYSTEM: "SYSTEM",
} as const;
export type BanSource = (typeof BanSource)[keyof typeof BanSource];

/** App state for presence */
export const AppState = {
  FOREGROUND: "FOREGROUND",
  BACKGROUND: "BACKGROUND",
  CLOSED: "CLOSED",
} as const;
export type AppState = (typeof AppState)[keyof typeof AppState];

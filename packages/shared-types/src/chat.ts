/**
 * Canonical chat wire DTO module — mirrors buildChatMessageEvent() output.
 * Field names are NON-BREAKING (existing canonical names, flat sender fields).
 * Import from "@aimess/shared-types".
 */

export type EpochMs = number;

export type ContentType =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "GIF"
  | "VOICE"
  | "DOCUMENT"
  | "STICKER"
  | "LOCATION"
  | "CONTACT"
  | "SYSTEM";

export type ConversationType = "PRIVATE" | "GROUP" | "COMMUNITY";

export interface MessageSenderDto {
  senderId: string;
  senderName: string;
  senderAvatar: string;
  senderRole: string;
}

export interface AttachmentDto {
  objectKey?: string;
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  blurhash?: string;
  waveform?: number[];
}

export interface LocationDto {
  lat: number;
  lng: number;
  placeName?: string;
  placeAddress?: string;
}

export interface ContactDto {
  name: string;
  phone: string;
  avatar?: string;
  userId?: string;
}

export interface StickerDto {
  objectKey?: string;
  url?: string;
  packId: string;
  stickerId: string;
}

export interface MentionDto {
  userId: string;
  username: string;
  offset: number;
  length: number;
}

export interface MessageContentDto {
  text: string;
  urls?: string[];
  files?: AttachmentDto[];
  location?: LocationDto;
  contact?: ContactDto;
  sticker?: StickerDto;
  mentions?: MentionDto[];
}

export interface CommunityCreatedMetadata {
  communityName: string;
  creatorId: string;
  creatorName: string;
}

export interface CommunityUpdatedMetadata {
  updaterId: string;
  updaterName: string;
  changedFields: string[];
  newName?: string;
  newVisibility?: string;
}

export interface MemberRoleChangedMetadata {
  actorId: string;
  actorName: string;
  targetUserId: string;
  targetName: string;
  oldRole: string;
  newRole: string;
}

export type SystemMessageMetadata =
  | CommunityCreatedMetadata
  | CommunityUpdatedMetadata
  | MemberRoleChangedMetadata;

export interface ReactionUserDto {
  userId: string;
  displayName: string;
  avatar: string;
}

export interface ReactionDto {
  emoji: string;
  count: number;
  users: ReactionUserDto[];
  selfReacted?: boolean;
}

/** Canonical reply snapshot (called quoteData in wire payloads). */
export interface ReplyDto {
  messageId: string;
  senderId: string;
  senderName: string;
  messageType: ContentType | "";
  preview: string;
  isDeleted: boolean;
}

export interface ForwardedMessageDto {
  originalMessageId: string;
  originalSenderId: string;
  originalSenderName: string;
  originalConversationId?: string;
}

/**
 * Canonical chat message wire DTO — matches buildChatMessageEvent() output.
 * Used for: REST send/edit/forward responses, socket message:new/edited, history enrichment.
 * V1 aliases (messageId, conversationId, sentAt, contentText, contentJson) preserved.
 */
export interface MessageDto extends MessageSenderDto {
  id: string;
  /** V1 alias for id */
  messageId: string;
  clientMessageId: string;
  roomId: string;
  /** V1 alias for roomId */
  conversationId: string;
  conversationType: ConversationType;
  receiverId: string;
  content: MessageContentDto | null;
  contentType: ContentType;
  /** V1: plain-text preview of content.text */
  contentText?: string;
  /** V1: JSON-stringified content */
  contentJson?: string;
  parentMessageId: string;
  /** Canonical reply snapshot (null if none). */
  quoteData: ReplyDto | null;
  reactions: ReactionDto[] | unknown;
  isForwarded?: true;
  forwardData?: ForwardedMessageDto | null;
  isDeleted: boolean;
  deletedType: string;
  editedAt: EpochMs;
  clientTs: EpochMs;
  serverTs: EpochMs;
  /** V1 alias for serverTs */
  sentAt: EpochMs;
  sequenceNumber: number;
  systemEvent?: string;
  systemData?: unknown;
  systemMessageType?: string | null;
  systemMetadata?: SystemMessageMetadata | null;
}

export interface ReadByEntryDto {
  userId: string;
  readAt: EpochMs;
}

export interface DeliveredEntryDto {
  userId: string;
  deliveredAt: EpochMs;
}

export interface ReadReceiptDto {
  conversationId: string;
  readerId: string;
  upToMessageId: string;
  readToSeq?: number;
  unreadCount?: number;
  conversationType?: ConversationType;
}

export interface TypingDto {
  conversationId: string;
  communityId?: string;
  userId: string;
  senderName: string;
  userDetails: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
  };
  timestamp: EpochMs;
}

/** Tombstone returned by REST delete and broadcast by socket message:delete. */
export interface DeletePayloadDto {
  messageId: string;
  conversationId: string;
  type: "forMe" | "forEveryone";
  deletedType?: string;
  deletedBy?: string;
  sequenceNumber: number;
}

/** Community-specific delete tombstone (uses communityId instead of conversationId). */
export interface CommunityDeletePayloadDto {
  messageId: string;
  communityId: string;
  roomId: string;
  deleteType: "forMe" | "forEveryone";
  deletedBy: string;
}

/** Community-specific edit response (thin shape until Phase 3 convergence). */
export interface CommunityEditResponseDto {
  messageId: string;
  communityId: string;
  roomId: string;
  senderId: string;
  message: string;
  contentType: ContentType | string;
  editedAt: EpochMs;
}

export type MessageSyncDto = MessageDto & {
  syncEventType: "new" | "edited" | "deleted" | "reacted";
};

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/community.proto"
);

export interface CommunityMediaFile {
  url?: string;
  objectKey?: string;
  name?: string;
  size?: number;
  mime?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  blurhash?: string;
  waveform?: number[];
}
export interface CommunityLocationAttachment {
  lat: number;
  lng: number;
  placeName?: string;
  placeAddress?: string;
}
export interface CommunityContactAttachment {
  name: string;
  phone: string;
  avatar?: string;
  userId?: string;
}
export interface CommunityStickerAttachment {
  objectKey?: string;
  url?: string;
  packId: string;
  stickerId: string;
}

export interface SendCommunityMessageParams {
  communityId: string;
  roomId: string;
  senderId: string;
  clientMessageId?: string;
  message: string;
  contentType: string;
  mediaFiles?: CommunityMediaFile[];
  location?: CommunityLocationAttachment;
  contact?: CommunityContactAttachment;
  sticker?: CommunityStickerAttachment;
  parentMessageId?: string;
}
export interface SendCommunityMessageResult {
  messageId: string;
  roomId: string;
  sentAt: number;
}
export interface GetCommunityMessagesParams {
  roomId: string;
  requesterId: string;
  cursor?: string;
  limit?: number;
}
export interface GetCommunityMessagesResponse {
  messages: CommunityMessageDto[];
  nextCursor: string;
  hasMore: boolean;
  /** JSON-encoded PinnedMessageSummary, or "" when the room has no active pin. */
  pinnedMessageJson: string;
}
export interface CommunityMessageDto {
  messageId: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  contentType: string;
  mediaKey: string;
  /** JSON-serialised SocketFileAttachment[] with presigned URLs. */
  attachmentsJson: string;
  /** JSON-serialised reaction groups. */
  reactionsJson: string;
  /** JSON-serialised quote data, or empty string. */
  quoteDataJson: string;
  sentAt: number;
  /** e.g. "COMMUNITY_JOINED" — empty string for normal messages. */
  systemMessageType?: string;
  /** JSON string of the system metadata map — empty string when absent. */
  systemMetadata?: string;
  /** true = user-scoped SYSTEM message ("You joined this community"). */
  isPersonal?: boolean;
}

export interface ReactCommunityMessageParams {
  messageId: string;
  communityId: string;
  userId: string;
  emoji: string;
}
export interface CommunityReactionUserDto {
  userId: string;
  displayName: string;
  avatar: string;
}
export interface CommunityReactionGroupDto {
  emoji: string;
  count: number;
  users: CommunityReactionUserDto[];
}
export interface ReactCommunityMessageResult {
  messageId: string;
  communityId: string;
  reactions: CommunityReactionGroupDto[];
}

export interface CommunityCatchupParams {
  roomId: string;
  requesterId: string;
  sinceId: string;
  limit?: number;
  /** Epoch-ms; when > 0 the server uses updatedAt-based query (catches edits/reactions/tombstones). */
  sinceTs?: number;
}
export interface CommunityCatchupEventDto {
  messageId: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  contentType: string;
  sentAt: number;
  isDeleted: boolean;
  deletedType: string;
  editedAt: number;
  /** "new" | "edited" | "deleted" | "reacted" */
  syncEventType: string;
  reactions: CommunityReactionGroupDto[];
}
export interface CommunityCatchupResponse {
  roomId: string;
  events: CommunityCatchupEventDto[];
  hasMore: boolean;
  lastId: string;
  authorized: boolean;
  /** Epoch-ms of the last event's updatedAt; use as next sinceTs when paging. 0 in sinceId mode. */
  nextTs: number;
}

// ---- Edit ----
export interface EditCommunityMessageParams {
  messageId: string;
  communityId: string;
  userId: string;
  text: string;
}
export interface EditCommunityMessageResult {
  messageId: string;
  communityId: string;
  roomId: string;
  editedAt: number;
  message: string;
  contentType: string;
}

// ---- Delete ----
export interface DeleteCommunityMessageParams {
  messageId: string;
  communityId: string;
  userId: string;
  deleteType: string; // "forEveryone" | "forMe"
}
export interface DeleteCommunityMessageResult {
  messageId: string;
  communityId: string;
  roomId: string;
  deleteType: string;
}

// ---- Pin ----
export interface PinCommunityMessageParams {
  messageId: string;
  communityId: string;
  roomId: string;
  userId: string;
}
export interface PinCommunityMessageResult {
  messageId: string;
  communityId: string;
  roomId: string;
  pinnedIds: string; // JSON string of string[]
  pinnedCount: number;
  pinnedAt: number;
}

// ---- Moderation ----
export interface ModerationActionResult {
  ok: boolean;
  communityId: string;
  targetUserId: string;
  errorCode: string;
}

export interface KickMemberParams {
  communityId: string;
  actorId: string;
  targetUserId: string;
  reason?: string;
}

export interface BanMemberParams {
  communityId: string;
  actorId: string;
  targetUserId: string;
  reason?: string;
}

export interface UnbanMemberParams {
  communityId: string;
  actorId: string;
  targetUserId: string;
}

export interface TransferAdminParams {
  communityId: string;
  actorId: string;
  newAdminId: string;
}

export interface ChangeMemberRoleParams {
  communityId: string;
  actorId: string;
  targetUserId: string;
  newRole: "MODERATOR" | "MEMBER";
}

export interface CreateReportParams {
  communityId: string;
  reporterId: string;
  reason: string;
  targetMessageId?: string;
}

export interface CreateReportResult {
  reportId: string;
  ok: boolean;
}

export interface DeleteCommunityParams {
  communityId: string;
  actorId: string;
  reason?: string;
}

// ---- Unpin ----
export interface UnpinCommunityMessageParams {
  messageId: string;
  communityId: string;
  roomId: string;
  userId: string;
}
export interface UnpinCommunityMessageResult {
  messageId: string;
  communityId: string;
  roomId: string;
  pinnedIds: string; // JSON string of string[]
  pinnedCount: number;
}

// ---- Mark message read ----
export interface MarkCommunityMessageReadParams {
  communityId: string;
  roomId: string;
  readerId: string;
  upToMessageId: string;
}
export interface MarkCommunityMessageReadResult {
  ok: boolean;
  communityId: string;
  readAt: number;
}

// ---- Get message reactions ----
export interface GetCommunityMessageReactionsParams {
  messageId: string;
  communityId: string;
  requesterId: string;
}
export interface GetCommunityMessageReactionsResult {
  messageId: string;
  communityId: string;
  reactions: CommunityReactionGroupDto[];
}

// ---- Forward message ----
export interface ForwardCommunityMessageParams {
  sourceMessageId: string;
  sourceCommunityId: string;
  targetCommunityId: string;
  targetRoomId: string;
  senderId: string;
  clientMessageId: string;
}
export interface ForwardCommunityMessageResult {
  messageId: string;
  roomId: string;
  sentAt: number;
}

// ---- Delivery receipt ----
export interface MarkCommunityMessageDeliveredParams {
  communityId: string;
  roomId: string;
  recipientId: string;
  upToMessageId: string;
}
export interface MarkCommunityMessageDeliveredResult {
  ok: boolean;
  communityId: string;
  deliveredAt: number;
}

// ---- Membership check (socket ban gate) ----
export interface CheckCommunityMembershipParams {
  communityId: string;
  userId: string;
}
export interface CheckCommunityMembershipResult {
  isMember: boolean;
  isBanned: boolean;
  status: string;
  role: string;
}

export interface GetUserActiveCommunityIdsResult {
  communityIds: string[];
}

export interface CommunityClient {
  getUserActiveCommunityIds(p: {
    userId: string;
  }): Promise<GetUserActiveCommunityIdsResult>;
  checkCommunityMembership(
    p: CheckCommunityMembershipParams
  ): Promise<CheckCommunityMembershipResult>;
  sendCommunityMessage(
    p: SendCommunityMessageParams
  ): Promise<SendCommunityMessageResult>;
  getCommunityMessages(
    p: GetCommunityMessagesParams
  ): Promise<GetCommunityMessagesResponse>;
  communityCatchup(
    p: CommunityCatchupParams
  ): Promise<CommunityCatchupResponse>;
  reactToCommunityMessage(
    p: ReactCommunityMessageParams
  ): Promise<ReactCommunityMessageResult>;
  editCommunityMessage(
    p: EditCommunityMessageParams
  ): Promise<EditCommunityMessageResult>;
  deleteCommunityMessage(
    p: DeleteCommunityMessageParams
  ): Promise<DeleteCommunityMessageResult>;
  pinCommunityMessage(
    p: PinCommunityMessageParams
  ): Promise<PinCommunityMessageResult>;
  unpinCommunityMessage(
    p: UnpinCommunityMessageParams
  ): Promise<UnpinCommunityMessageResult>;

  markCommunityMessageRead(
    p: MarkCommunityMessageReadParams
  ): Promise<MarkCommunityMessageReadResult>;
  getCommunityMessageReactions(
    p: GetCommunityMessageReactionsParams
  ): Promise<GetCommunityMessageReactionsResult>;
  forwardCommunityMessage(
    p: ForwardCommunityMessageParams
  ): Promise<ForwardCommunityMessageResult>;
  markCommunityMessageDelivered(
    p: MarkCommunityMessageDeliveredParams
  ): Promise<MarkCommunityMessageDeliveredResult>;

  // Moderation
  kickMember(p: KickMemberParams): Promise<ModerationActionResult>;
  banMember(p: BanMemberParams): Promise<ModerationActionResult>;
  unbanMember(p: UnbanMemberParams): Promise<ModerationActionResult>;
  transferAdmin(p: TransferAdminParams): Promise<ModerationActionResult>;
  changeMemberRole(p: ChangeMemberRoleParams): Promise<ModerationActionResult>;
  createReport(p: CreateReportParams): Promise<CreateReportResult>;
  deleteCommunity(p: DeleteCommunityParams): Promise<ModerationActionResult>;
}

export function createCommunityClient(): CommunityClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.COMMUNITY_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const sendMsgBreaker = makeBreaker(
    "community.sendCommunityMessage",
    (p: SendCommunityMessageParams) =>
      call<unknown, SendCommunityMessageResult>("sendCommunityMessage", {
        communityId: p.communityId,
        roomId: p.roomId,
        senderId: p.senderId,
        clientMessageId: p.clientMessageId ?? "",
        message: p.message,
        contentType: p.contentType,
        mediaKey: "",
        parentMessageId: p.parentMessageId ?? "",
        attachmentsJson: JSON.stringify({
          ...(p.mediaFiles?.length ? { files: p.mediaFiles } : {}),
          ...(p.location ? { location: p.location } : {}),
          ...(p.contact ? { contact: p.contact } : {}),
          ...(p.sticker ? { sticker: p.sticker } : {}),
        }),
        // int64 `sentAt` arrives as a string (proto-loader longs:String); coerce
        // so the ack matches the `community:message:new` broadcast (a number).
      }).then((r) => ({ ...r, sentAt: Number(r.sentAt) }))
  );
  const getMsgsBreaker = makeBreaker(
    "community.getCommunityMessages",
    (p: GetCommunityMessagesParams) =>
      call<unknown, GetCommunityMessagesResponse>("getCommunityMessages", {
        roomId: p.roomId,
        requesterId: p.requesterId,
        cursor: p.cursor ?? "",
        limit: p.limit ?? 30,
        // int64 `sentAt` arrives as a string (proto-loader longs:String).
      }).then((r) => ({
        ...r,
        messages: r.messages.map((m) => ({ ...m, sentAt: Number(m.sentAt) })),
      }))
  );
  const catchupBreaker = makeBreaker(
    "community.communityCatchup",
    (p: CommunityCatchupParams) =>
      call<unknown, CommunityCatchupResponse>("communityCatchup", {
        roomId: p.roomId,
        requesterId: p.requesterId,
        sinceId: p.sinceId,
        limit: p.limit ?? 100,
        sinceTs: p.sinceTs ?? 0,
      })
  );
  const reactBreaker = makeBreaker(
    "community.reactToCommunityMessage",
    (p: ReactCommunityMessageParams) =>
      call<unknown, ReactCommunityMessageResult>("reactToCommunityMessage", {
        messageId: p.messageId,
        communityId: p.communityId,
        userId: p.userId,
        emoji: p.emoji,
      })
  );

  const editMsgBreaker = makeBreaker(
    "community.editCommunityMessage",
    (p: EditCommunityMessageParams) =>
      call<unknown, EditCommunityMessageResult>("editCommunityMessage", {
        messageId: p.messageId,
        communityId: p.communityId,
        userId: p.userId,
        text: p.text,
        // int64 `editedAt` arrives as a string (proto-loader longs:String).
      }).then((r) => ({ ...r, editedAt: Number(r.editedAt) }))
  );
  const deleteMsgBreaker = makeBreaker(
    "community.deleteCommunityMessage",
    (p: DeleteCommunityMessageParams) =>
      call<unknown, DeleteCommunityMessageResult>("deleteCommunityMessage", {
        messageId: p.messageId,
        communityId: p.communityId,
        userId: p.userId,
        deleteType: p.deleteType,
      })
  );
  const pinMsgBreaker = makeBreaker(
    "community.pinCommunityMessage",
    (p: PinCommunityMessageParams) =>
      call<unknown, PinCommunityMessageResult>("pinCommunityMessage", {
        messageId: p.messageId,
        communityId: p.communityId,
        roomId: p.roomId,
        userId: p.userId,
        // int64 `pinnedAt` arrives as a string (proto-loader longs:String).
      }).then((r) => ({ ...r, pinnedAt: Number(r.pinnedAt) }))
  );
  const unpinMsgBreaker = makeBreaker(
    "community.unpinCommunityMessage",
    (p: UnpinCommunityMessageParams) =>
      call<unknown, UnpinCommunityMessageResult>("unpinCommunityMessage", {
        messageId: p.messageId,
        communityId: p.communityId,
        roomId: p.roomId,
        userId: p.userId,
      })
  );

  const kickBreaker = makeBreaker(
    "community.kickMember",
    (p: KickMemberParams) =>
      call<unknown, ModerationActionResult>("kickMember", {
        communityId: p.communityId,
        actorId: p.actorId,
        targetUserId: p.targetUserId,
        reason: p.reason ?? "",
      })
  );
  const banBreaker = makeBreaker("community.banMember", (p: BanMemberParams) =>
    call<unknown, ModerationActionResult>("banMember", {
      communityId: p.communityId,
      actorId: p.actorId,
      targetUserId: p.targetUserId,
      reason: p.reason ?? "",
    })
  );
  const unbanBreaker = makeBreaker(
    "community.unbanMember",
    (p: UnbanMemberParams) =>
      call<unknown, ModerationActionResult>("unbanMember", {
        communityId: p.communityId,
        actorId: p.actorId,
        targetUserId: p.targetUserId,
      })
  );
  const transferAdminBreaker = makeBreaker(
    "community.transferAdmin",
    (p: TransferAdminParams) =>
      call<unknown, ModerationActionResult>("transferAdmin", {
        communityId: p.communityId,
        actorId: p.actorId,
        newAdminId: p.newAdminId,
      })
  );
  const changeRoleBreaker = makeBreaker(
    "community.changeMemberRole",
    (p: ChangeMemberRoleParams) =>
      call<unknown, ModerationActionResult>("changeMemberRole", {
        communityId: p.communityId,
        actorId: p.actorId,
        targetUserId: p.targetUserId,
        newRole: p.newRole,
      })
  );
  const createReportBreaker = makeBreaker(
    "community.createReport",
    (p: CreateReportParams) =>
      call<unknown, CreateReportResult>("createReport", {
        communityId: p.communityId,
        reporterId: p.reporterId,
        reason: p.reason,
        targetMessageId: p.targetMessageId ?? "",
      })
  );
  const deleteCommunityBreaker = makeBreaker(
    "community.deleteCommunity",
    (p: DeleteCommunityParams) =>
      call<unknown, ModerationActionResult>("deleteCommunity", {
        communityId: p.communityId,
        actorId: p.actorId,
        reason: p.reason ?? "",
      })
  );

  const markReadBreaker = makeBreaker(
    "community.markCommunityMessageRead",
    (p: MarkCommunityMessageReadParams) =>
      call<unknown, MarkCommunityMessageReadResult>(
        "markCommunityMessageRead",
        {
          communityId: p.communityId,
          roomId: p.roomId,
          readerId: p.readerId,
          upToMessageId: p.upToMessageId,
        }
      ).then((r) => ({ ...r, readAt: Number(r.readAt) }))
  );

  const getReactionsBreaker = makeBreaker(
    "community.getCommunityMessageReactions",
    (p: GetCommunityMessageReactionsParams) =>
      call<unknown, GetCommunityMessageReactionsResult>(
        "getCommunityMessageReactions",
        {
          messageId: p.messageId,
          communityId: p.communityId,
          requesterId: p.requesterId,
        }
      )
  );

  const forwardMsgBreaker = makeBreaker(
    "community.forwardCommunityMessage",
    (p: ForwardCommunityMessageParams) =>
      call<unknown, ForwardCommunityMessageResult>("forwardCommunityMessage", {
        sourceMessageId: p.sourceMessageId,
        sourceCommunityId: p.sourceCommunityId,
        targetCommunityId: p.targetCommunityId,
        targetRoomId: p.targetRoomId,
        senderId: p.senderId,
        clientMessageId: p.clientMessageId,
      }).then((r) => ({ ...r, sentAt: Number(r.sentAt) }))
  );

  const checkMembershipBreaker = makeBreaker(
    "community.checkCommunityMembership",
    (p: CheckCommunityMembershipParams) =>
      call<unknown, CheckCommunityMembershipResult>(
        "checkCommunityMembership",
        {
          communityId: p.communityId,
          userId: p.userId,
        }
      )
  );

  const getUserActiveCommunityIdsBreaker = makeBreaker(
    "community.getUserActiveCommunityIds",
    (p: { userId: string }) =>
      call<unknown, GetUserActiveCommunityIdsResult>(
        "getUserActiveCommunityIds",
        { userId: p.userId }
      )
  );

  const markDeliveredBreaker = makeBreaker(
    "community.markCommunityMessageDelivered",
    (p: MarkCommunityMessageDeliveredParams) =>
      call<unknown, MarkCommunityMessageDeliveredResult>(
        "markCommunityMessageDelivered",
        {
          communityId: p.communityId,
          roomId: p.roomId,
          recipientId: p.recipientId,
          upToMessageId: p.upToMessageId,
        }
      ).then((r) => ({ ...r, deliveredAt: Number(r.deliveredAt) }))
  );

  return {
    getUserActiveCommunityIds: (p) => getUserActiveCommunityIdsBreaker.fire(p),
    checkCommunityMembership: (p) => checkMembershipBreaker.fire(p),
    markCommunityMessageRead: (p) => markReadBreaker.fire(p),
    getCommunityMessageReactions: (p) => getReactionsBreaker.fire(p),
    forwardCommunityMessage: (p) => forwardMsgBreaker.fire(p),
    sendCommunityMessage: (p) => sendMsgBreaker.fire(p),
    getCommunityMessages: (p) => getMsgsBreaker.fire(p),
    communityCatchup: (p) => catchupBreaker.fire(p),
    reactToCommunityMessage: (p) => reactBreaker.fire(p),
    editCommunityMessage: (p) => editMsgBreaker.fire(p),
    deleteCommunityMessage: (p) => deleteMsgBreaker.fire(p),
    pinCommunityMessage: (p) => pinMsgBreaker.fire(p),
    unpinCommunityMessage: (p) => unpinMsgBreaker.fire(p),
    kickMember: (p) => kickBreaker.fire(p),
    banMember: (p) => banBreaker.fire(p),
    unbanMember: (p) => unbanBreaker.fire(p),
    transferAdmin: (p) => transferAdminBreaker.fire(p),
    changeMemberRole: (p) => changeRoleBreaker.fire(p),
    createReport: (p) => createReportBreaker.fire(p),
    deleteCommunity: (p) => deleteCommunityBreaker.fire(p),
    markCommunityMessageDelivered: (p) => markDeliveredBreaker.fire(p),
  };
}

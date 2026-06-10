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
}
export interface CommunityMessageDto {
  messageId: string;
  roomId: string;
  senderId: string;
  message: string;
  contentType: string;
  mediaKey: string;
  sentAt: number;
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

export interface CommunityClient {
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
      })
  );
  const getMsgsBreaker = makeBreaker(
    "community.getCommunityMessages",
    (p: GetCommunityMessagesParams) =>
      call<unknown, GetCommunityMessagesResponse>("getCommunityMessages", {
        roomId: p.roomId,
        requesterId: p.requesterId,
        cursor: p.cursor ?? "",
        limit: p.limit ?? 30,
      })
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
      })
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
      })
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

  return {
    sendCommunityMessage: (p) => sendMsgBreaker.fire(p),
    getCommunityMessages: (p) => getMsgsBreaker.fire(p),
    communityCatchup: (p) => catchupBreaker.fire(p),
    reactToCommunityMessage: (p) => reactBreaker.fire(p),
    editCommunityMessage: (p) => editMsgBreaker.fire(p),
    deleteCommunityMessage: (p) => deleteMsgBreaker.fire(p),
    pinCommunityMessage: (p) => pinMsgBreaker.fire(p),
    unpinCommunityMessage: (p) => unpinMsgBreaker.fire(p),
  };
}

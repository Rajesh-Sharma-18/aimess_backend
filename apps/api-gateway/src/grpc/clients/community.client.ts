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

export interface SendCommunityMessageParams {
  communityId: string;
  roomId: string;
  senderId: string;
  clientMessageId: string;
  message: string;
  contentType: string;
  mediaKey?: string;
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

export interface CommunityClient {
  sendCommunityMessage(
    p: SendCommunityMessageParams
  ): Promise<SendCommunityMessageResult>;
  getCommunityMessages(
    p: GetCommunityMessagesParams
  ): Promise<GetCommunityMessagesResponse>;
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
        clientMessageId: p.clientMessageId,
        message: p.message,
        contentType: p.contentType,
        mediaKey: p.mediaKey ?? "",
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

  return {
    sendCommunityMessage: (p) => sendMsgBreaker.fire(p),
    getCommunityMessages: (p) => getMsgsBreaker.fire(p),
  };
}

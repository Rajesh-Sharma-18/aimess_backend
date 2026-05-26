import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";
import { env } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/community.proto"
);

const BREAKER_OPTS = {
  timeout: 2000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 5,
};

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

function makeBreaker<T, R>(
  name: string,
  fn: (p: T) => Promise<R>
): CircuitBreaker<[T], R> {
  const breaker = new CircuitBreaker(fn, { ...BREAKER_OPTS, name });
  breaker.fallback(() => {
    throw new Error(`${name} unavailable`);
  });
  breaker.on("open", () => logger.warn(`Circuit opened: ${name}`));
  breaker.on("halfOpen", () => logger.info(`Circuit half-open: ${name}`));
  return breaker;
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

  function call<TReq, TRes>(method: string, req: TReq): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const typed = client as unknown as Record<
        string,
        (r: TReq, cb: (e: grpc.ServiceError | null, res: TRes) => void) => void
      >;
      typed[method](req, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

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

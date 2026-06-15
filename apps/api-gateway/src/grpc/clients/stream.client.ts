import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/stream.proto"
);

/**
 * One livestream comment as returned to the socket client. The wire `created_at`
 * is an int64 (proto-loader longs:String) — coerced to Number here so the
 * relayed socket ack matches the declared `number` type.
 */
export interface StreamComment {
  id: string;
  sentBy: string;
  senderName: string;
  senderAvatar: string;
  message: string;
  createdAt: number;
}

export interface PostCommentParams {
  livestreamId: string;
  userId: string;
  message: string;
  /** "" when the client did not supply one; used for idempotency downstream. */
  clientCommentId?: string;
}
export interface PostCommentResult {
  comment: StreamComment;
}

export interface GetCommentsParams {
  livestreamId: string;
  /** Page size; 0 = server default. */
  limit?: number;
  /** Exclusive cursor (comment id); "" = latest page. */
  before?: string;
}
export interface GetCommentsResult {
  comments: StreamComment[];
  nextCursor: string;
  hasMore: boolean;
}

export interface StreamClient {
  postComment(p: PostCommentParams): Promise<PostCommentResult>;
  getComments(p: GetCommentsParams): Promise<GetCommentsResult>;
}

/** int64 createdAt arrives as a string (proto-loader longs:String); coerce. */
function normalizeComment(c: StreamComment): StreamComment {
  return { ...c, createdAt: Number(c.createdAt) };
}

export function createStreamClient(): StreamClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["stream"] as grpc.GrpcObject)[
    "StreamService"
  ] as grpc.ServiceClientConstructor;

  const client = new ServiceCtor(
    env.STREAM_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const postCommentBreaker = makeBreaker(
    "stream.postComment",
    (p: PostCommentParams) =>
      call<unknown, PostCommentResult>("postComment", {
        livestreamId: p.livestreamId,
        userId: p.userId,
        message: p.message,
        clientCommentId: p.clientCommentId ?? "",
      }).then((r) => ({ comment: normalizeComment(r.comment) }))
  );

  const getCommentsBreaker = makeBreaker(
    "stream.getComments",
    (p: GetCommentsParams) =>
      call<unknown, GetCommentsResult>("getComments", {
        livestreamId: p.livestreamId,
        limit: p.limit ?? 0,
        before: p.before ?? "",
      }).then((r) => ({
        ...r,
        comments: (r.comments ?? []).map(normalizeComment),
      }))
  );

  return {
    postComment: (p) => postCommentBreaker.fire(p),
    getComments: (p) => getCommentsBreaker.fire(p),
  };
}

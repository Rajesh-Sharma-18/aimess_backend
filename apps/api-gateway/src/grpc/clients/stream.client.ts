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
  /** Exclusive cursor — fetch older comments (id < before); "" = latest page. */
  before?: string;
  /** Exclusive cursor — fetch newer comments (id > after); used for reconnect catch-up. */
  after?: string;
  /** Authenticated caller — enforces the stream ban gate server-side. */
  requesterId?: string;
}
export interface GetCommentsResult {
  comments: StreamComment[];
  nextCursor: string;
  hasMore: boolean;
}

export interface CheckStreamAccessParams {
  streamId: string;
  userId: string;
}
export interface CheckStreamAccessResult {
  allowed: boolean;
  isBanned: boolean;
  /** Membership status: ACTIVE | PENDING | OWNER | "" */
  status: string;
  reason: string;
  canComment: boolean;
  /** Stream lifecycle status: PENDING | LIVE | ENDED | CANCELLED */
  streamStatus: string;
  title: string;
  description: string;
  /** Raw thumbnail object key; "" if none */
  thumbnail: string;
  creatorId: string;
  /** "" if none (e.g. YOUTUBE source type) */
  hlsUrl: string;
  flvUrl: string;
}

export interface DeleteCommentParams {
  commentId: string;
  requesterId: string;
}
export interface DeleteCommentResult {
  success: boolean;
  commentId: string;
  livestreamId: string;
}

/** Durable viewer-session tracking — fire-and-forget from the caller side. */
export interface RecordViewerJoinParams {
  streamId: string;
  userId: string;
}
export interface RecordViewerLeaveParams {
  streamId: string;
  userId: string;
}

export interface StreamClient {
  postComment(p: PostCommentParams): Promise<PostCommentResult>;
  getComments(p: GetCommentsParams): Promise<GetCommentsResult>;
  checkStreamAccess(
    p: CheckStreamAccessParams
  ): Promise<CheckStreamAccessResult>;
  deleteComment(p: DeleteCommentParams): Promise<DeleteCommentResult>;
  recordViewerJoin(p: RecordViewerJoinParams): Promise<void>;
  recordViewerLeave(p: RecordViewerLeaveParams): Promise<void>;
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
        after: p.after ?? "",
        requesterId: p.requesterId ?? "",
      }).then((r) => ({
        ...r,
        comments: (r.comments ?? []).map(normalizeComment),
      }))
  );

  const checkAccessBreaker = makeBreaker(
    "stream.checkStreamAccess",
    (p: CheckStreamAccessParams) =>
      call<unknown, CheckStreamAccessResult>("checkStreamAccess", {
        streamId: p.streamId,
        userId: p.userId,
      })
  );

  const deleteCommentBreaker = makeBreaker(
    "stream.deleteComment",
    (p: DeleteCommentParams) =>
      call<unknown, DeleteCommentResult>("deleteComment", {
        commentId: p.commentId,
        requesterId: p.requesterId,
      }).then((r) => ({
        success: r.success ?? false,
        commentId: r.commentId ?? "",
        livestreamId: r.livestreamId ?? "",
      }))
  );

  const recordViewerJoinBreaker = makeBreaker(
    "stream.recordViewerJoin",
    (p: RecordViewerJoinParams) =>
      call<unknown, { sessionId: string }>("recordViewerJoin", {
        streamId: p.streamId,
        userId: p.userId,
      })
  );

  const recordViewerLeaveBreaker = makeBreaker(
    "stream.recordViewerLeave",
    (p: RecordViewerLeaveParams) =>
      call<unknown, { success: boolean }>("recordViewerLeave", {
        streamId: p.streamId,
        userId: p.userId,
      })
  );

  return {
    postComment: (p) => postCommentBreaker.fire(p),
    getComments: (p) => getCommentsBreaker.fire(p),
    checkStreamAccess: (p) => checkAccessBreaker.fire(p),
    deleteComment: (p) => deleteCommentBreaker.fire(p),
    // Durable viewer-session tracking — callers treat these as best-effort
    // (wrap in try/catch, never block the join/leave ack on the result).
    recordViewerJoin: (p) => recordViewerJoinBreaker.fire(p).then(() => {}),
    recordViewerLeave: (p) => recordViewerLeaveBreaker.fire(p).then(() => {}),
  };
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

export interface ReconcileMember {
  userId: string;
  status: string; // ACTIVE | PENDING | BANNED | LEFT
  role: string; // ADMIN | MODERATOR | MEMBER
  joinedAt: string; // epoch ms (proto int64 → string under longs:String)
}

export interface ReconcileCommunity {
  id: string;
  name: string;
  adminId: string;
  avatarUrl: string;
  deleted: boolean;
  /** PUBLIC | PRIVATE — drives non-member read access. May be "" on older servers. */
  communityType: string;
  members: ReconcileMember[];
}

export interface ListCommunitiesResult {
  communities: ReconcileCommunity[];
  nextAfterId: string;
  hasMore: boolean;
}

export interface UpdateReactionActivityParams {
  communityId: string;
  added: boolean;
  messageId: string;
  emoji: string;
  actorId: string;
  actorPreview?: string;
  targetId?: string | null;
  targetPreview?: string | null;
  /** epoch ms; only meaningful when added = true. */
  reactedAt?: number;
}

export interface UpdateMessageActivityParams {
  communityId: string;
  /** epoch ms; ignored in self-hide mode (selfUserId set). */
  lastMessageAt?: number;
  lastMessageId?: string;
  senderUserId?: string;
  senderUsername?: string;
  messagePreview?: string;
  /** default "message" when omitted. */
  activityType?: string;
  /**
   * Delete-for-me personal self-hide overlay: when set, ONLY
   * lastActivityUserId/lastActivitySelfPreview are written community-service-
   * side — every canonical field above is ignored. Leave unset (or "") for
   * the normal canonical bump (message send/edit/delete-for-everyone).
   */
  selfUserId?: string;
  selfPreview?: string;
  /**
   * ROLLBACK mode (epoch ms; omit/0 = off). community-service's canonical bump is
   * forward-only, so it cannot express "the last message was deleted — fall back
   * to the previous one, which is OLDER". Set this to the REMOVED message's
   * `createdAt` and pass the previous-visible message's real `createdAt` as
   * `lastMessageAt`: the write then applies backward, but only while the stored
   * `lastActivityAt` is not newer than this (a message that landed after the
   * delete wins and the rollback is skipped).
   */
  rollbackNotNewerThan?: number;
  clientMessageId?: string | null;
  seq?: number;
  contentType?: string;
}

export interface CheckCommunityMembershipParams {
  communityId: string;
  userId: string;
}
export interface CheckCommunityMembershipResult {
  /** True only when the user has an ACTIVE membership row. */
  isMember: boolean;
  isBanned: boolean;
  /** ACTIVE | BANNED | LEFT | PENDING | "" (no row). */
  status: string;
  /**
   * The AUTHORITATIVE role from community-service's `CommunityMember` table
   * (ADMIN | MODERATOR | MEMBER, uppercase), "" if not a member. This is the
   * source of truth for role-based authorization — chat-service's own
   * `RoomMember.role` is only a one-way, async, best-effort mirror of this
   * value (see `events/community-room-sync.consumer.ts`) and can go stale.
   */
  role: string;
}

export interface CommunityInviteContextQuery {
  communityId: string;
  /** Invite/permanent code carried on the message; "" to skip link-status resolution. */
  code?: string;
}
export interface CommunityInviteContext {
  communityId: string;
  /** False when the community was deleted (or never existed). */
  found: boolean;
  communityName: string;
  communityHandle: string;
  isMember: boolean;
  linkStatus: "ACTIVE" | "EXPIRED" | "REVOKED" | "DELETED";
  /** PUBLIC | PRIVATE; "" when `found` is false. Decides whether a non-member's
   *  card offers "Join" or "Request to Join". */
  communityType?: string;
  /** True when the viewer holds a PENDING join request. Never true alongside
   *  `isMember` — membership outranks the request it left behind. */
  joinRequestPending?: boolean;
}

export interface CommunityReconcileClient {
  listCommunities(p: {
    afterId?: string;
    limit?: number;
  }): Promise<ListCommunitiesResult>;
  /**
   * Synchronous companion to the async `community.activity.queue`
   * "reaction_added"/"reaction_removed" publish — see the proto doc. Callers
   * should treat a `false`/thrown result as non-fatal: the async queue
   * publish (sent separately, unconditionally) remains the resiliency
   * backstop, so a reaction must never fail just because this call did.
   */
  updateReactionActivity(p: UpdateReactionActivityParams): Promise<boolean>;
  /**
   * Synchronous companion to the async `community.activity.queue` "message"
   * publish for the canonical lastActivity bump, and the ONLY path for the
   * delete-for-me personal self-hide overlay (the queue never carries that).
   * See the proto doc for the two modes. Same non-fatal contract as
   * {@link updateReactionActivity} — a `false`/thrown result must never fail
   * the delete/send/edit itself.
   */
  updateMessageActivity(p: UpdateMessageActivityParams): Promise<boolean>;
  /**
   * Live membership + role lookup against community-service's authoritative
   * `CommunityMember` table — the SAME RPC api-gateway already uses for its
   * socket ban-gate. This is the one place chat-service asks "what is this
   * user's CURRENT role", instead of trusting the locally-mirrored (and
   * possibly stale) `RoomMember.role`. Never throws — any transport/timeout
   * failure resolves to the safe "not a member" default
   * (`{isMember:false, isBanned:false, status:"", role:""}`), which fails
   * CLOSED for role-gated actions (matches `assertCommunityRole` in
   * `lib/access-guard.ts`, its only caller).
   */
  checkCommunityMembership(
    p: CheckCommunityMembershipParams
  ): Promise<CheckCommunityMembershipResult>;
  /**
   * Batch-resolve the `systemAction` card context (community found/name/
   * handle, viewer membership, invite-code validity) for every COMMUNITY_
   * INVITATION message on a history page in one round trip. Never throws —
   * a transport failure degrades to an empty array; callers fall back to
   * treating the invite as still-valid using the message's own stored data
   * (a temporary outage must not make every past invite look broken).
   */
  getCommunityInviteContexts(
    userId: string,
    queries: CommunityInviteContextQuery[]
  ): Promise<CommunityInviteContext[]>;
  /**
   * Batch name + presigned avatar_url for a set of community ids, resolved
   * fresh on every call (reuses the same admin-panel RPC backoffice-service
   * uses for its Livestream Management list — never persist the returned
   * URL, it's a MinIO presign that expires). Used to refresh notification-row
   * community avatars at read time instead of trusting a stale URL baked
   * into the notification's stored event payload. Never throws — a
   * transport failure degrades to an empty array.
   */
  getCommunitiesByIds(communityIds: string[]): Promise<CommunityAvatarBrief[]>;
}

export interface CommunityAvatarBrief {
  communityId: string;
  name: string;
  avatarUrl: string;
}

/**
 * Outbound gRPC client to community-service's CommunityService.ListCommunities,
 * used only by the boot-time room reconciler. Wrapped in an opossum breaker like
 * the other cross-service clients; a longer timeout than the 2s default since a
 * reconciliation page carries communities + their members.
 */
export function createCommunityReconcileClient(): CommunityReconcileClient {
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

  const listBreaker = makeBreaker(
    "community.listCommunities",
    (p: { afterId?: string; limit?: number }) =>
      call<unknown, ListCommunitiesResult>("listCommunities", {
        afterId: p.afterId ?? "",
        limit: p.limit ?? 0,
      }),
    { timeout: 10_000 }
  );

  // Short timeout — this call is awaited inline in the reaction request path;
  // a slow/unreachable community-service must not stall the reaction response
  // for long. The async queue publish (sent unconditionally alongside this)
  // is what actually guarantees eventual persistence.
  const updateReactionActivityBreaker = makeBreaker(
    "community.updateReactionActivity",
    (p: UpdateReactionActivityParams) =>
      call<unknown, { ok: boolean }>("updateReactionActivity", {
        communityId: p.communityId,
        added: p.added,
        messageId: p.messageId,
        emoji: p.emoji,
        actorId: p.actorId,
        actorPreview: p.actorPreview ?? "",
        targetId: p.targetId ?? "",
        targetPreview: p.targetPreview ?? "",
        reactedAt: String(p.reactedAt ?? 0),
      }),
    { timeout: 1_500 }
  );

  // Same short-timeout reasoning as updateReactionActivity: awaited inline in
  // the delete/send/edit request path.
  const updateMessageActivityBreaker = makeBreaker(
    "community.updateMessageActivity",
    (p: UpdateMessageActivityParams) =>
      call<unknown, { ok: boolean }>("updateMessageActivity", {
        communityId: p.communityId,
        lastMessageAt: String(p.lastMessageAt ?? 0),
        lastMessageId: p.lastMessageId ?? "",
        senderUserId: p.senderUserId ?? "",
        senderUsername: p.senderUsername ?? "",
        messagePreview: p.messagePreview ?? "",
        activityType: p.activityType ?? "message",
        selfUserId: p.selfUserId ?? "",
        selfPreview: p.selfPreview ?? "",
      }),
    { timeout: 1_500 }
  );

  // Short timeout — awaited inline on hot authorization paths (pin/unpin/
  // delete-for-everyone). A slow/unreachable community-service must not stall
  // the request; the caller treats a failure as "not a member" (fail-closed
  // for a permission check — see CheckCommunityMembershipResult doc).
  const checkMembershipBreaker = makeBreaker(
    "community.checkCommunityMembership",
    (p: CheckCommunityMembershipParams) =>
      call<unknown, CheckCommunityMembershipResult>(
        "checkCommunityMembership",
        { communityId: p.communityId, userId: p.userId }
      ),
    { timeout: 1_500 }
  );

  const NOT_A_MEMBER: CheckCommunityMembershipResult = {
    isMember: false,
    isBanned: false,
    status: "",
    role: "",
  };

  // Awaited inline while building a REST history page — bounded by page size
  // (a handful of invite cards at most), so the default timeout is fine.
  const inviteContextsBreaker = makeBreaker(
    "community.getCommunityInviteContexts",
    (p: { userId: string; queries: CommunityInviteContextQuery[] }) =>
      call<unknown, { contexts?: CommunityInviteContext[] }>(
        "getCommunityInviteContexts",
        {
          userId: p.userId,
          queries: p.queries.map((q) => ({
            communityId: q.communityId,
            code: q.code ?? "",
          })),
        }
      ).then((r) => r.contexts ?? [])
  );
  inviteContextsBreaker.fallback(() => []);

  const communitiesByIdsBreaker = makeBreaker(
    "community.adminGetCommunitiesByIds",
    (p: { communityIds: string[] }) =>
      call<unknown, { communities?: CommunityAvatarBrief[] }>(
        "adminGetCommunitiesByIds",
        { communityIds: p.communityIds }
      ).then((r) => r.communities ?? [])
  );
  communitiesByIdsBreaker.fallback(() => []);

  return {
    listCommunities: (p) => listBreaker.fire(p),
    updateReactionActivity: async (p) => {
      try {
        const res = await updateReactionActivityBreaker.fire(p);
        return Boolean(res?.ok);
      } catch {
        return false;
      }
    },
    updateMessageActivity: async (p) => {
      try {
        const res = await updateMessageActivityBreaker.fire(p);
        return Boolean(res?.ok);
      } catch {
        return false;
      }
    },
    checkCommunityMembership: async (p) => {
      try {
        return (await checkMembershipBreaker.fire(p)) ?? NOT_A_MEMBER;
      } catch {
        return NOT_A_MEMBER;
      }
    },
    getCommunityInviteContexts: async (userId, queries) => {
      if (!userId || queries.length === 0) return [];
      try {
        return await inviteContextsBreaker.fire({ userId, queries });
      } catch {
        return [];
      }
    },
    getCommunitiesByIds: async (communityIds) => {
      if (communityIds.length === 0) return [];
      try {
        return await communitiesByIdsBreaker.fire({ communityIds });
      } catch {
        return [];
      }
    },
  };
}

/** Lazily-created shared client (one gRPC channel per process) — mirrors
 *  community-service's `getChatClient()`. */
let cached: CommunityReconcileClient | undefined;
export function getCommunityReconcileClient(): CommunityReconcileClient {
  cached ??= createCommunityReconcileClient();
  return cached;
}

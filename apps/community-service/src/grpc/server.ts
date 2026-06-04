import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

import {
  CommunityModerationStatus,
  CommunityType,
} from "../generated/prisma/index.js";
import { communityRepository } from "../repositories/community.repository.js";

/** Resolve the admin moderation "status" string of a community row, treating an
 * unset moderationStatus (legacy rows) as ACTIVE. SUSPENDED → "CLOSED". */
function moderationStatusToWire(
  status: CommunityModerationStatus | null | undefined
): "ACTIVE" | "CLOSED" {
  return status === CommunityModerationStatus.SUSPENDED ? "CLOSED" : "ACTIVE";
}

/** Clamp a 1-based page (default 1). */
function coercePage(page: unknown): number {
  const n = Number(page);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Clamp a page size to 1..100 (default 20). */
function coerceLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(Math.floor(n), 100);
}

/** ISO date (YYYY-MM-DD) → start-of-day UTC Date; empty/invalid → undefined. */
function dateFromBound(s: unknown): Date | undefined {
  if (typeof s !== "string" || s.trim() === "") return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** ISO date (YYYY-MM-DD) → end-of-day UTC Date; empty/invalid → undefined. */
function dateToBound(s: unknown): Date | undefined {
  if (typeof s !== "string" || s.trim() === "") return undefined;
  const d = new Date(`${s}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

const communityImpl: grpc.UntypedServiceImplementation = {
  sendCommunityMessage: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => callback(null, { messageId: "", roomId: "", sentAt: 0 }),

  getCommunityMessages: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => callback(null, { messages: [], nextCursor: "", hasMore: false }),

  // Reconciliation pull: chat-service lists communities (+ members) on boot to
  // provision any missing chat rooms / sync RoomMember rows. Cursor on community id.
  listCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { afterId?: string; limit?: number };
        const limit =
          req.limit && req.limit > 0 ? Math.min(req.limit, 200) : 100;
        // Over-fetch one for an exact hasMore.
        const rows = await communityRepository.listForReconciliation({
          afterId: req.afterId || null,
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        callback(null, {
          communities: page.map((c) => ({
            id: c.id,
            name: c.name,
            adminId: c.adminId,
            avatarUrl: c.avatarUrl ?? "",
            deleted: c.deletedAt != null,
            members: c.members.map((m) => ({
              userId: m.userId,
              status: String(m.status),
              role: String(m.role),
              joinedAt: m.joinedAt instanceof Date ? m.joinedAt.getTime() : 0,
            })),
          })),
          nextAfterId: hasMore && last ? last.id : "",
          hasMore,
        });
      } catch (err) {
        logger.error("listCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "listCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin dashboard: count of active (non-soft-deleted) communities.
  getCommunityCount: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const total = await communityRepository.countActiveCommunities();
        callback(null, { total });
      } catch (err) {
        logger.error("getCommunityCount gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "getCommunityCount failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // ---- Backoffice (admin panel) Community Management ----
  // Read-through list for the admin Community Management screen. Offset paginated.
  adminListCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          search?: string;
          type?: string;
          category?: string;
          status?: string;
          createdFrom?: string;
          createdTo?: string;
          sortField?: string;
          sortDir?: string;
          page?: number;
          limit?: number;
        };

        const type =
          req.type === "PUBLIC"
            ? CommunityType.PUBLIC
            : req.type === "PRIVATE"
              ? CommunityType.PRIVATE
              : undefined;
        const status =
          req.status === "ACTIVE"
            ? "ACTIVE"
            : req.status === "CLOSED"
              ? "CLOSED"
              : undefined;

        const { rows, total } = await communityRepository.adminListCommunities({
          search: req.search?.trim() || undefined,
          type,
          category: req.category?.trim() || undefined,
          status,
          createdFrom: dateFromBound(req.createdFrom),
          createdTo: dateToBound(req.createdTo),
          sortField: req.sortField || "createdAt",
          sortDir: req.sortDir === "asc" ? "asc" : "desc",
          page: coercePage(req.page),
          limit: coerceLimit(req.limit),
        });

        callback(null, {
          communities: rows.map((r) => ({
            communityId: r.id,
            name: r.name,
            handle: r.handle,
            adminId: r.adminId,
            adminName: r.adminName,
            adminUsername: r.adminUsername,
            adminAvatarUrl: r.adminAvatar,
            type: String(r.type),
            categoryId: r.categoryId,
            categoryName: r.category?.name ?? "",
            categorySlug: r.category?.slug ?? "",
            status: moderationStatusToWire(r.moderationStatus),
            memberCount: r.memberCount,
            livestreamCount: 0, // STUB until stream-service is wired
            createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : 0,
          })),
          total,
        });
      } catch (err) {
        logger.error("adminListCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin Community Management detail. `found:false` + empty community when missing.
  adminGetCommunity: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { communityId?: string };
        const communityId = (req.communityId || "").trim();
        const detail = communityId
          ? await communityRepository.adminGetCommunityDetail(communityId)
          : null;

        if (!detail) {
          callback(null, {
            found: false,
            community: {
              communityId: "",
              name: "",
              handle: "",
              adminId: "",
              adminName: "",
              adminUsername: "",
              adminAvatarUrl: "",
              type: "",
              categoryId: "",
              categoryName: "",
              categorySlug: "",
              status: "",
              memberCount: 0,
              livestreamCount: 0,
              createdAt: 0,
            },
            description: "",
            coverUrl: "",
            lastActivityAt: 0,
            membersTotal: 0,
            membersActive: 0,
            membersPending: 0,
            membersBanned: 0,
            membersModerators: 0,
            membersJoinedLast7d: 0,
            openReports: 0,
            activeInviteLinks: 0,
            joinPolicy: "",
            ownerEmail: "",
            ownerAccountStatus: "",
          });
          return;
        }

        const c = detail.community;
        callback(null, {
          found: true,
          community: {
            communityId: c.id,
            name: c.name,
            handle: c.handle,
            adminId: c.adminId,
            adminName: detail.adminName,
            adminUsername: detail.adminUsername,
            adminAvatarUrl: detail.adminAvatar,
            type: String(c.type),
            categoryId: c.categoryId,
            categoryName: c.category?.name ?? "",
            categorySlug: c.category?.slug ?? "",
            status: moderationStatusToWire(c.moderationStatus),
            memberCount: c.memberCount,
            livestreamCount: 0, // STUB until stream-service is wired
            createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : 0,
          },
          description: c.description ?? "",
          coverUrl: c.coverUrl ?? "",
          lastActivityAt:
            c.lastActivityAt instanceof Date ? c.lastActivityAt.getTime() : 0,
          membersTotal: detail.membersTotal,
          membersActive: detail.membersActive,
          membersPending: detail.membersPending,
          membersBanned: detail.membersBanned,
          membersModerators: detail.membersModerators,
          membersJoinedLast7d: detail.membersJoinedLast7d,
          openReports: detail.openReports,
          activeInviteLinks: detail.activeInviteLinks,
          joinPolicy: c.type === CommunityType.PRIVATE ? "REQUEST" : "OPEN",
          // Best-effort until enriched cross-service (see proto comment).
          ownerEmail: "",
          ownerAccountStatus: "ACTIVE",
        });
      } catch (err) {
        logger.error("adminGetCommunity gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminGetCommunity failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin close/reopen. Business failures (not-found / already-closed / not-closed)
  // are returned in the payload `errorCode` (NOT thrown) so the caller maps them
  // to HTTP 404/409 cleanly. Only infra errors throw gRPC INTERNAL.
  adminSetModerationStatus: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          status?: string;
          reasonCode?: string;
          actorAdminId?: string;
        };
        const communityId = (req.communityId || "").trim();
        const target =
          req.status === "SUSPENDED"
            ? CommunityModerationStatus.SUSPENDED
            : CommunityModerationStatus.ACTIVE;

        if (!communityId) {
          callback(null, {
            ok: false,
            status: "ACTIVE",
            closedAt: 0,
            errorCode: "COMMUNITY_NOT_FOUND",
          });
          return;
        }

        const result = await communityRepository.adminSetModerationStatus(
          communityId,
          target,
          req.reasonCode?.trim() || null,
          req.actorAdminId?.trim() || null
        );
        callback(null, {
          ok: result.ok,
          status: result.status,
          closedAt: result.closedAt,
          errorCode: result.errorCode,
        });
      } catch (err) {
        logger.error("adminSetModerationStatus gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminSetModerationStatus failed",
        } as grpc.ServiceError);
      }
    })();
  },
};

export function startGrpcServer(port: number): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const CommunityService = (proto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(CommunityService.service, communityImpl);

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`community-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `community-service gRPC server listening on port ${boundPort}`
      );
    }
  );

  return server;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { withServiceAuth } from "@aimess/grpc-utils";
import { isAppError } from "@aimess/errors";
import { env } from "../config/env.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { userSettingsRepository } from "../repositories/user-settings.repository.js";
import { friendshipService } from "../services/friendship.service.js";
import { buildDisplayName } from "../lib/profile-fields.util.js";
import { SCHEMA_DEFAULT_SCOPE, scopeAdmits } from "../lib/privacy-scope.js";
import { avatarService } from "../services/avatar.service.js";
import {
  buildFriendshipView,
  toChatRelationship,
} from "../lib/friendship-view.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AdminProfileRecord {
  userId: string;
  username: string;
  avatarUrl: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}

/** Map a UserProfile row to the gRPC AdminProfileRecord shape. */
function toAdminProfileRecord(row: {
  userId: string;
  username: string;
  avatarUrl: string | null;
  firstName: string;
  lastName: string;
  createdAt: Date;
}): AdminProfileRecord {
  return {
    userId: row.userId,
    username: row.username,
    avatarUrl: row.avatarUrl ?? "",
    firstName: row.firstName,
    lastName: row.lastName,
    createdAt: row.createdAt.toISOString(),
  };
}
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

export function startUserGrpcServer(): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const UserService = (proto["user"] as grpc.GrpcObject)[
    "UserService"
  ] as unknown as grpc.ServiceClientConstructor;

  // With keepCase: false, proto fields user_a → userA, user_b → userB, are_friends → areFriends
  const userImpl: grpc.UntypedServiceImplementation = {
    checkFriendship: (
      call: grpc.ServerUnaryCall<{ userA: string; userB: string }, unknown>,
      callback: grpc.sendUnaryData<{ areFriends: boolean }>
    ) => {
      void (async () => {
        try {
          const { userA, userB } = call.request;
          const row = await friendshipRepository.findActivePair(userA, userB);
          callback(null, { areFriends: row !== null });
        } catch (err) {
          logger.error(`gRPC checkFriendship error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Callee-scoped call-privacy read for the chat-service `initiateCall` gate.
    // See Docs/calls/CALLS-LIVEKIT.md §7 Phase 2.
    getCallPrivacy: (
      call: grpc.ServerUnaryCall<{ userId: string }, unknown>,
      callback: grpc.sendUnaryData<{
        whoCanCallMe: string;
        allowedUserIds: string[];
      }>
    ) => {
      void (async () => {
        try {
          const row = await userSettingsRepository.findCallPrivacy(
            call.request.userId
          );
          callback(null, row);
        } catch (err) {
          logger.error(`gRPC getCallPrivacy error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Subject-scoped Settings → Chat block: the default auto-delete timer for
    // chat-service's send path, plus the typing-indicator / read-receipt
    // switches the gateway and chat-service enforce on this user's behalf.
    getChatSettings: (
      call: grpc.ServerUnaryCall<{ userId: string }, unknown>,
      callback: grpc.sendUnaryData<{
        autoDeleteTimer: string;
        typingIndicators: boolean;
        readReceipts: boolean;
      }>
    ) => {
      void (async () => {
        try {
          callback(
            null,
            await userSettingsRepository.findChatSettings(call.request.userId)
          );
        } catch (err) {
          logger.error(`gRPC getChatSettings error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Viewer-scoped presence filter for the gateway's `presence:subscribe`
    // gate. Returns only the peers whose `whoCanSeeOnlineStatus` admits this
    // viewer; on any error the caller must fail CLOSED (empty list), never open.
    filterVisiblePresence: (
      call: grpc.ServerUnaryCall<
        { viewerId: string; peerIds: string[] },
        unknown
      >,
      callback: grpc.sendUnaryData<{ visiblePeerIds: string[] }>
    ) => {
      void (async () => {
        try {
          const viewerId = call.request.viewerId ?? "";
          const peerIds = [...new Set(call.request.peerIds ?? [])]
            .filter((id) => UUID_RE.test(id))
            .slice(0, 500);
          if (!UUID_RE.test(viewerId) || peerIds.length === 0) {
            callback(null, { visiblePeerIds: [] });
            return;
          }
          const [friendIds, scopeByUserId] = await Promise.all([
            friendshipRepository.findAcceptedFriendIdsForUser(
              viewerId,
              peerIds
            ),
            userSettingsRepository.findOnlineVisibilityScopes(peerIds),
          ]);
          const friendSet = new Set(friendIds);
          callback(null, {
            visiblePeerIds: peerIds.filter((peerId) =>
              scopeAdmits(
                // Missing row → FRIENDS (the schema default), NOT EVERYONE.
                scopeByUserId.get(peerId) ??
                  SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus,
                // Presence has no FRIENDS_OF_FRIENDS option, so the one-hop
                // graph is never consulted here.
                {
                  isSelf: peerId === viewerId,
                  isFriend: friendSet.has(peerId),
                }
              )
            ),
          });
        } catch (err) {
          logger.error(`gRPC filterVisiblePresence error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Inverse of filterVisiblePresence: ONE subject, MANY viewers. Used on the
    // fan-out side (presence bumps, conv:updated `isOffline`), where the
    // subject's scope is read once and the audience filtered against it — the
    // viewer-scoped RPC would need one call per recipient there.
    filterPresenceViewers: (
      call: grpc.ServerUnaryCall<
        { subjectId: string; viewerIds: string[] },
        unknown
      >,
      callback: grpc.sendUnaryData<{ allowedViewerIds: string[] }>
    ) => {
      void (async () => {
        try {
          const subjectId = call.request.subjectId ?? "";
          const viewerIds = [...new Set(call.request.viewerIds ?? [])]
            .filter((id) => UUID_RE.test(id))
            .slice(0, 500);
          if (!UUID_RE.test(subjectId) || viewerIds.length === 0) {
            callback(null, { allowedViewerIds: [] });
            return;
          }
          const [friendIds, scopeByUserId] = await Promise.all([
            friendshipRepository.findAcceptedFriendIdsForUser(
              subjectId,
              viewerIds
            ),
            userSettingsRepository.findOnlineVisibilityScopes([subjectId]),
          ]);
          const friendSet = new Set(friendIds);
          // Missing row → FRIENDS (the schema default), NOT EVERYONE.
          const scope =
            scopeByUserId.get(subjectId) ??
            SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus;
          callback(null, {
            allowedViewerIds: viewerIds.filter((viewerId) =>
              scopeAdmits(scope, {
                isSelf: viewerId === subjectId,
                isFriend: friendSet.has(viewerId),
              })
            ),
          });
        } catch (err) {
          logger.error(`gRPC filterPresenceViewers error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Per-category notification preferences. When no row exists yet, default to
    // "all enabled" so notifications-service still delivers (allow-by-default).
    getNotificationSettings: (
      call: grpc.ServerUnaryCall<{ userId: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const { userId } = call.request;
          const row =
            await userSettingsRepository.findNotificationSettings(userId);
          callback(null, {
            chatEnabled: row?.chatEnabled ?? true,
            callEnabled: row?.callEnabled ?? true,
            friendRequestEnabled: row?.friendRequestEnabled ?? true,
            systemEnabled: row?.systemEnabled ?? true,
            communityEnabled: row?.communityEnabled ?? true,
            liveStreamEnabled: row?.liveStreamEnabled ?? true,
            showPreview: row?.showPreview ?? true,
            quietHoursEnabled: row?.quietHoursEnabled ?? false,
            quietHoursStart: row?.quietHoursStart ?? "",
            quietHoursEnd: row?.quietHoursEnd ?? "",
            quietHoursDays: row?.quietHoursDays ?? [],
          });
        } catch (err) {
          logger.error(`gRPC getNotificationSettings error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Panel: enrich a user list with display profile data.
    adminGetProfilesByIds: (
      call: grpc.ServerUnaryCall<{ userIds: string[] }, unknown>,
      callback: grpc.sendUnaryData<{ profiles: AdminProfileRecord[] }>
    ) => {
      void (async () => {
        try {
          const { userIds } = call.request;
          const rows =
            await userProfileRepository.adminGetProfilesByIds(userIds);
          callback(null, { profiles: rows.map(toAdminProfileRecord) });
        } catch (err) {
          logger.error(`gRPC adminGetProfilesByIds error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Panel (Reports search): match userIds by name/username.
    adminSearchProfileIds: (
      call: grpc.ServerUnaryCall<{ search: string }, unknown>,
      callback: grpc.sendUnaryData<{ userIds: string[] }>
    ) => {
      void (async () => {
        try {
          const { search } = call.request;
          const userIds = await userProfileRepository.adminSearchProfileIds(
            search ?? ""
          );
          callback(null, { userIds });
        } catch (err) {
          logger.error(`gRPC adminSearchProfileIds error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Panel: single profile lookup by id.
    adminGetProfile: (
      call: grpc.ServerUnaryCall<{ userId: string }, unknown>,
      callback: grpc.sendUnaryData<AdminProfileRecord>
    ) => {
      void (async () => {
        try {
          const { userId } = call.request;
          const row = await userProfileRepository.adminGetProfile(userId);
          if (row === null) {
            callback({
              code: grpc.status.NOT_FOUND,
              message: "PROFILE_NOT_FOUND",
            });
            return;
          }
          callback(null, toAdminProfileRecord(row));
        } catch (err) {
          logger.error(`gRPC adminGetProfile error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Internal: bulk user profile snapshot (replaces HTTP /api/v1/users/internal/bulk-snapshot)
    bulkGetUserSnapshots: (
      call: grpc.ServerUnaryCall<{ userIds: string[] }, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { userIds?: string[] };
          const userIds = req.userIds ?? [];
          if (userIds.length === 0) {
            callback(null, { users: [] });
            return;
          }
          const profiles = await userProfileRepository.findManyByUserIds(
            userIds.slice(0, 500)
          );
          // Resolve a fresh presigned URL per profile — same resolver
          // /users/search uses — so callers (chat-service notification
          // enrichment, etc.) never persist a URL that later expires.
          const avatarViews = await Promise.all(
            profiles.map((p) =>
              avatarService.resolveViewUrlForClient(p.avatarUrl)
            )
          );
          callback(null, {
            users: profiles.map((p, i) => ({
              userId: p.userId,
              username: p.username,
              displayName: buildDisplayName(p.firstName, p.lastName),
              avatarObjectKey: p.avatarUrl ?? "",
              avatarUrl: avatarViews[i]?.url ?? "",
            })),
          });
        } catch (err) {
          logger.error(`gRPC bulkGetUserSnapshots error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Internal: bulk friendship check (replaces HTTP /api/v1/users/internal/friendship-check)
    checkFriendships: (
      call: grpc.ServerUnaryCall<
        { callerId: string; candidateIds: string[] },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            callerId?: string;
            candidateIds?: string[];
          };
          const callerId = req.callerId ?? "";
          const candidateIds = [...new Set(req.candidateIds ?? [])].slice(
            0,
            500
          );
          if (!callerId || candidateIds.length === 0) {
            callback(null, { friendIds: [], relationships: [] });
            return;
          }
          const [friendIds, { rows, blockedIds }] = await Promise.all([
            friendshipRepository.findAcceptedFriendIdsForUser(
              callerId,
              candidateIds
            ),
            friendshipRepository.findRelationshipsForUser(
              callerId,
              candidateIds
            ),
          ]);
          const rowByPeer = new Map(
            rows.map((r) => [
              r.requesterId === callerId ? r.addresseeId : r.requesterId,
              r,
            ])
          );
          const relationships = candidateIds.map((userId) => {
            const row = rowByPeer.get(userId) ?? null;
            const view = buildFriendshipView(
              callerId,
              row,
              blockedIds.has(userId)
            );
            const relationship = toChatRelationship(view);
            const isPending = view.status === "PENDING";
            return {
              userId,
              status: relationship.status,
              direction: relationship.direction ?? "",
              friendshipId: row?.id ?? "",
              requesterId: isPending && row ? row.requesterId : "",
              canAccept: view.canAccept,
              canReject: view.canReject,
              canCancel: view.canCancel,
            };
          });
          callback(null, { friendIds, relationships });
        } catch (err) {
          logger.error(`gRPC checkFriendships error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Internal: resolve the *current* friendship state for a Notification
    // Center row, viewer-relative. Notification rows are immutable, so the
    // caller must re-derive status/direction/canAccept-etc at read time.
    getFriendshipView: (
      call: grpc.ServerUnaryCall<
        { friendshipId: string; viewerId: string },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            friendshipId?: string;
            viewerId?: string;
          };
          const friendshipId = req.friendshipId ?? "";
          const viewerId = req.viewerId ?? "";
          if (!friendshipId || !viewerId) {
            callback(null, {
              found: false,
              status: "NONE",
              direction: "",
              canAccept: false,
              canReject: false,
              canCancel: false,
            });
            return;
          }

          const row = await friendshipRepository.findById(friendshipId);
          let isBlocked = false;
          if (row) {
            const [aBlockedB, bBlockedA] = await Promise.all([
              friendshipRepository.findBlock(row.requesterId, row.addresseeId),
              friendshipRepository.findBlock(row.addresseeId, row.requesterId),
            ]);
            isBlocked = Boolean(aBlockedB || bBlockedA);
          }

          const view = buildFriendshipView(viewerId, row, isBlocked);
          callback(null, {
            found: row !== null,
            status: view.status,
            direction: view.direction ?? "",
            canAccept: view.canAccept,
            canReject: view.canReject,
            canCancel: view.canCancel,
          });
        } catch (err) {
          logger.error(`gRPC getFriendshipView error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Panel ONLY (see the .proto doc) — platform-wide unfriend sweep.
    // Access control is backoffice-service's RBAC + audit log around this
    // call, NOT this handler; `confirm` here is only a blast-radius trip-wire.
    adminDisconnectAllFriendships: (
      call: grpc.ServerUnaryCall<{ confirm: boolean }, unknown>,
      callback: grpc.sendUnaryData<{
        friendshipsDisconnected: number;
        usersAffected: number;
      }>
    ) => {
      void (async () => {
        try {
          const result = await friendshipService.disconnectAllPlatform({
            confirm: Boolean(call.request.confirm),
          });
          callback(null, result);
        } catch (err) {
          if (isAppError(err) && err.statusCode === 400) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: err.messageKey ?? err.message,
            });
            return;
          }
          logger.error(
            `gRPC adminDisconnectAllFriendships error: ${String(err)}`
          );
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const server = new grpc.Server();
  server.addService(
    UserService.service,
    withServiceAuth("user-service", userImpl)
  );

  server.bindAsync(
    `0.0.0.0:${env.USER_GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`user-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(
        `user-service gRPC server listening on port ${String(boundPort)}`
      );
    }
  );

  return server;
}

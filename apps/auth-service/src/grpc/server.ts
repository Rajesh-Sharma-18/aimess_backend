import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { withServiceAuth } from "@aimess/grpc-utils";

import { adminStatsRepository } from "../repositories/admin-stats.repository.js";
import { adminUsersRepository } from "../repositories/admin-users.repository.js";
import type { AuthUser } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";
import { accountService } from "../services/account.service.js";
import { accountBanService } from "../services/account-ban.service.js";
import { accountRestoreService } from "../services/account-restore.service.js";
import { prisma } from "../config/prisma.js";

// Map an AuthUser row to the wire AdminUserRecord. Status is normalized for the
// admin view: PENDING_DELETION → "DELETED", and any row with deletedAt set is
// reported as "DELETED" even if its status column lags behind.
function toAdminUserRecord(row: AuthUser): Record<string, string> {
  let status: string = row.status;
  if (status === "PENDING_DELETION" || row.deletedAt != null) {
    status = "DELETED";
  }
  return {
    id: row.id,
    account: row.account,
    email: row.email ?? "",
    status,
    createdAt: row.createdAt?.toISOString() ?? "",
    suspendedAt: row.suspendedAt?.toISOString() ?? "",
    suspendedReason: row.suspendedReason ?? "",
    deletedAt: row.deletedAt?.toISOString() ?? "",
    lastLoginAt: row.lastLoginAt?.toISOString() ?? "",
  };
}

// auth-service is ESM ("type":"module"), so derive the directory from
// import.meta — a bare __dirname resolves to the Prisma client's globalThis
// shim, which points at src/generated/prisma and breaks this path. Depth is
// identical from src/grpc (tsx) and dist/grpc (built) to the repo root.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  currentDir,
  "../../../../packages/grpc-contracts/proto/auth.proto"
);

const authImpl: grpc.UntypedServiceImplementation = {
  // Admin dashboard: total / new-today / banned user counts.
  getUserCounts: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const counts = await adminStatsRepository.getUserCounts();
        callback(null, {
          totalUsers: counts.totalUsers,
          newUsersToday: counts.newUsersToday,
          bannedUsers: counts.bannedUsers,
        });
      } catch (err) {
        logger.error(`gRPC getUserCounts error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin dashboard: DAU/MAU from session activity. Window sizes come from the
  // caller (default 24h / 30d applied here when unset/zero).
  getActiveUserCounts: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          dauWindowHours?: number;
          mauWindowDays?: number;
        };
        const dauWindowHours =
          req.dauWindowHours && req.dauWindowHours > 0
            ? req.dauWindowHours
            : 24;
        const mauWindowDays =
          req.mauWindowDays && req.mauWindowDays > 0 ? req.mauWindowDays : 30;

        const counts = await adminStatsRepository.getActiveUserCounts({
          dauWindowHours,
          mauWindowDays,
        });
        callback(null, {
          dailyActive: counts.dailyActive,
          monthlyActive: counts.monthlyActive,
        });
      } catch (err) {
        logger.error(`gRPC getActiveUserCounts error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin dashboard: per-day active/churned series over an inclusive UTC date
  // range. Bucketed live from session activity (see repository for windows).
  getActiveUserSeries: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        // keepCase:false on the loader → camelCase request fields.
        const req = call.request as { startDate?: string; endDate?: string };
        const startDate = req.startDate ?? "";
        const endDate = req.endDate ?? "";

        const buckets = await adminStatsRepository.getActiveUserSeries(
          startDate,
          endDate
        );
        callback(null, {
          buckets: buckets.map((b) => ({
            date: b.date,
            dailyActive: b.dailyActive,
            monthlyActive: b.monthlyActive,
            churned: b.churned,
          })),
        });
      } catch (err) {
        logger.error(`gRPC getActiveUserSeries error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin Panel: filterable/sortable/paginated real-user list.
  adminListUsers: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        // keepCase:false on the loader → camelCase request fields.
        const req = call.request as {
          search?: string;
          status?: string[];
          createdAfter?: string;
          createdBefore?: string;
          sortField?: string;
          sortDir?: string;
          limit?: number;
          offset?: number;
          userIds?: string[];
          excludeUserIds?: string[];
        };

        const { users, total } = await adminUsersRepository.adminListUsers({
          search: req.search ?? "",
          status: req.status ?? [],
          createdAfter: req.createdAfter ?? "",
          createdBefore: req.createdBefore ?? "",
          sortField: req.sortField ?? "",
          sortDir: req.sortDir ?? "",
          limit: req.limit ?? 0,
          offset: req.offset ?? 0,
          userIds: req.userIds ?? [],
          excludeUserIds: req.excludeUserIds ?? [],
        });

        callback(null, {
          users: users.map(toAdminUserRecord),
          total,
        });
      } catch (err) {
        logger.error(`gRPC adminListUsers error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin Panel: users with a live session on the given device type(s).
  adminListUserIdsByDeviceType: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          deviceTypes?: string[];
          limit?: number;
          offset?: number;
        };

        const { userIds, total } =
          await adminUsersRepository.adminListUserIdsByDeviceType({
            deviceTypes: req.deviceTypes ?? [],
            limit: req.limit ?? 0,
            offset: req.offset ?? 0,
          });

        callback(null, { userIds, total });
      } catch (err) {
        logger.error(`gRPC adminListUserIdsByDeviceType error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin Panel: fetch a single real user by id.
  adminGetUser: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { userId?: string };
        const row = await adminUsersRepository.adminGetUser(req.userId ?? "");
        if (!row) {
          callback({
            code: grpc.status.NOT_FOUND,
            message: "USER_NOT_FOUND",
          });
          return;
        }
        callback(null, toAdminUserRecord(row));
      } catch (err) {
        logger.error(`gRPC adminGetUser error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Internal: user-service fetches account summary by userId over gRPC (replaces HTTP /api/auth/internal/account)
  getAccountSummary: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { userId?: string };
        const userId = req.userId ?? "";
        if (!userId) {
          callback({
            code: grpc.status.INVALID_ARGUMENT,
            message: "user_id required",
          });
          return;
        }
        const summary = await accountService.getAccountSummary(userId);
        callback(null, {
          userId: summary.userId,
          account: summary.account,
          email: summary.email ?? "",
          emailVerified: summary.emailVerified,
          hasPassword: summary.hasPassword,
          primaryAccount: summary.primaryAccount ?? "",
          providers: summary.providers.map((p) => ({
            provider: p.provider,
            connected: p.connected,
            providerUserId: p.providerUserId ?? "",
            providerEmail: p.providerEmail ?? "",
            linkedAt: p.linkedAt ?? "",
          })),
        });
      } catch (err) {
        logger.error(`gRPC getAccountSummary error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Internal: backoffice-service asks before creating/renaming an admin account.
  // Soft-deleted users still count as taken — the row keeps the unique index on
  // `email`, so handing the address to an admin would break a later restore.
  isUserEmailTaken: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { email?: string };
        const email = (req.email ?? "").trim().toLowerCase();
        if (!email) {
          callback(null, { taken: false });
          return;
        }
        const user = await authRepository.findByEmail(email);
        callback(null, { taken: user !== null });
      } catch (err) {
        logger.error(`gRPC isUserEmailTaken error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Internal: chat-service fetches account names in bulk (replaces HTTP /api/internal/accounts)
  bulkGetAccounts: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { userIds?: string[] };
        const userIds = req.userIds ?? [];
        if (userIds.length === 0) {
          callback(null, { accounts: [] });
          return;
        }
        // `deletedAt: null` is load-bearing, not hygiene. This RPC exists only
        // as chat-service's LAST-RESORT display-name fallback for a user whose
        // user-service profile row does not exist yet, and `account` is the
        // login handle — the single most identifying string on the account. A
        // deleted user must never resolve through it, so the gap is left open
        // and the caller falls through to its neutral placeholder instead.
        const users = await prisma.authUser.findMany({
          where: { id: { in: userIds.slice(0, 500) }, deletedAt: null },
          select: { id: true, account: true },
        });
        callback(null, {
          accounts: users.map((u) => ({ userId: u.id, account: u.account })),
        });
      } catch (err) {
        logger.error(`gRPC bulkGetAccounts error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Admin Panel: permanently ban / reinstate an account. The only mutation on
  // this service, and the reason a ban now actually blocks re-login.
  //
  // Business failures come back as `error_code` with ok=false rather than a
  // gRPC error, so backoffice can map them to a clean 404/400; only genuine
  // infrastructure faults throw, because backoffice treats those as fatal and
  // aborts the ban rather than writing a mirror row for a ban that did not land.
  adminSetAccountStatus: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        userId?: string;
        status?: string;
        reason?: string;
        actorAdminId?: string;
      };
      const userId = req.userId ?? "";
      const status = (req.status ?? "").toUpperCase();

      if (!userId) {
        callback(null, {
          ok: false,
          status: "",
          revokedSessions: 0,
          errorCode: "USER_NOT_FOUND",
        });
        return;
      }
      if (status !== "BANNED" && status !== "ACTIVE") {
        callback(null, {
          ok: false,
          status: "",
          revokedSessions: 0,
          errorCode: "INVALID_STATUS",
        });
        return;
      }

      try {
        const input = {
          userId,
          reason: req.reason ? req.reason : null,
          actorAdminId: req.actorAdminId ? req.actorAdminId : null,
        };
        const result =
          status === "BANNED"
            ? await accountBanService.apply(input)
            : await accountBanService.lift(input);
        callback(null, {
          ok: true,
          status: result.status,
          revokedSessions: result.revokedSessions,
          errorCode: "",
        });
      } catch (err) {
        if (err instanceof Error && err.message === "USER_NOT_FOUND") {
          callback(null, {
            ok: false,
            status: "",
            revokedSessions: 0,
            errorCode: "USER_NOT_FOUND",
          });
          return;
        }
        logger.error(`gRPC adminSetAccountStatus error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
    })();
  },

  // Super Admin "Re-Activate": PENDING_DELETION → ACTIVE, plus the
  // `user.restored` fanout that un-deletes the profile in user-service.
  // Kept out of adminSetAccountStatus because that RPC's ACTIVE branch is
  // accountBanService.lift, which refuses deleted accounts by design.
  adminRestoreAccount: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        userId?: string;
        actorAdminId?: string;
      };
      const userId = req.userId ?? "";

      if (!userId) {
        callback(null, {
          ok: false,
          status: "",
          restoredAt: "",
          errorCode: "USER_NOT_FOUND",
        });
        return;
      }

      try {
        const result = await accountRestoreService.restore({
          userId,
          actorAdminId: req.actorAdminId ? req.actorAdminId : null,
        });
        callback(null, {
          ok: true,
          status: result.status,
          restoredAt: result.restoredAt.toISOString(),
          errorCode: "",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message === "USER_NOT_FOUND" || message === "USER_NOT_DELETED") {
          callback(null, {
            ok: false,
            status: "",
            restoredAt: "",
            errorCode: message,
          });
          return;
        }
        // Anything else is the awaited `user.restored` publish failing (broker
        // down). auth is ACTIVE but the profile is still deleted, so report it
        // as a distinct code: the caller must NOT mark the user reactivated,
        // and the admin retries — restore is idempotent.
        logger.error(`gRPC adminRestoreAccount error: ${String(err)}`);
        callback(null, {
          ok: false,
          status: "",
          restoredAt: "",
          errorCode: "RESTORE_NOT_PUBLISHED",
        });
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
  const AuthService = (proto["auth"] as grpc.GrpcObject)[
    "AuthService"
  ] as unknown as grpc.ServiceClientConstructor;

  const server = new grpc.Server();
  server.addService(
    AuthService.service,
    withServiceAuth("auth-service", authImpl)
  );

  // Bounded EADDRINUSE retry: under `tsx watch`, a packages/* rebuild restarts
  // every service at once and a new instance can try to bind before the old one
  // has released the port. Previously the bind error was only logged and gRPC
  // stayed dead for the life of that instance; retry briefly so it self-heals.
  const MAX_BIND_ATTEMPTS = 5;
  let bindAttempt = 0;
  const tryBind = () => {
    bindAttempt += 1;
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          const inUse = /EADDRINUSE/.test(err.message);
          if (inUse && bindAttempt < MAX_BIND_ATTEMPTS) {
            logger.warn(
              `auth-service gRPC port ${String(port)} busy (EADDRINUSE); retry ${bindAttempt}/${MAX_BIND_ATTEMPTS} in 500ms…`
            );
            setTimeout(tryBind, 500);
            return;
          }
          logger.error(`auth-service gRPC failed to bind: ${err.message}`);
          return;
        }
        logger.info(`auth-service gRPC server listening on port ${boundPort}`);
      }
    );
  };
  tryBind();

  return server;
}

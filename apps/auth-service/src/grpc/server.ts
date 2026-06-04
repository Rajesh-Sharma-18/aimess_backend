import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";

import { adminStatsRepository } from "../repositories/admin-stats.repository.js";
import { adminUsersRepository } from "../repositories/admin-users.repository.js";
import type { AuthUser } from "../generated/prisma/client.js";

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

// auth-service compiles to CommonJS (no "type":"module"), so __dirname is a
// global here — do NOT use import.meta. Depth is identical from src/grpc (tsx)
// and dist/grpc (built) to the repo root.
const PROTO_PATH = path.resolve(
  __dirname,
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
  server.addService(AuthService.service, authImpl);

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

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";
import { makeGrpcCallWithDeadline } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/auth.proto"
);

interface AccountEntry {
  userId: string;
  account: string;
}

interface BulkAccountsResult {
  accounts: AccountEntry[];
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["auth"] as grpc.GrpcObject)[
  "AuthService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.AUTH_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

const bulkGetAccountsBreaker: Breaker<
  { userIds: string[] },
  BulkAccountsResult
> = makeBreaker("auth.bulkGetAccounts", (args: { userIds: string[] }) =>
  call<{ userIds: string[] }, BulkAccountsResult>("bulkGetAccounts", args)
);

export const authGrpcClient = {
  async bulkGetAccounts(
    userIds: string[]
  ): Promise<Array<{ userId: string; account: string }>> {
    const result = await bulkGetAccountsBreaker.fire({ userIds });
    return result.accounts ?? [];
  },
};
/*
 * NOTE — deliberate: this client intentionally has NO opossum circuit breaker
 * (unlike the outbound gRPC clients in backoffice-service). These calls only
 * enrich admin reads with email and degrade to ""/[] on any failure, so chat
 * -service availability must NOT be coupled to auth-service. A breaker that
 * threw on open would defeat that. The calls go through @aimess/grpc-utils'
 * makeGrpcCallWithDeadline (deadline-bounded, breaker-free) rather than a
 * bespoke promisify wrapper.
 */

/** auth-service AdminUserRecord (keepCase:false → camelCase). */
interface RawAdminUserRecord {
  id: string;
  account: string;
  email: string;
  status: string;
}
interface RawAdminListUsersResponse {
  users: RawAdminUserRecord[];
  total: string | number;
}

/** Identity record the chat-service admin path consumes (email from auth). */
export interface AuthUserRecord {
  userId: string;
  account: string;
  email: string;
  status: string;
}

export interface AuthAdminClient {
  /**
   * Batched email/account resolution for a set of user ids. Never throws —
   * returns an empty Map on any failure so callers degrade gracefully.
   */
  resolveUsersByIds(userIds: string[]): Promise<Map<string, AuthUserRecord>>;
  /**
   * Free-text search over auth users (email + account). Returns the matching
   * user ids, capped at `limit`. Never throws — returns [] on any failure.
   */
  searchUserIds(term: string, limit: number): Promise<string[]>;
}

const DEADLINE_MS = 3000;

function deadline(): Date {
  return new Date(Date.now() + DEADLINE_MS);
}

export function createAuthAdminClient(): AuthAdminClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["auth"] as grpc.GrpcObject)[
    "AuthService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.AUTH_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  function adminListUsers(
    req: Record<string, unknown>
  ): Promise<RawAdminListUsersResponse> {
    return makeGrpcCallWithDeadline<
      Record<string, unknown>,
      RawAdminListUsersResponse
    >(client, "adminListUsers", req, deadline());
  }

  return {
    async resolveUsersByIds(
      userIds: string[]
    ): Promise<Map<string, AuthUserRecord>> {
      const ids = [...new Set(userIds.filter(Boolean))];
      const map = new Map<string, AuthUserRecord>();
      if (!ids.length) return map;
      try {
        const res = await adminListUsers({
          search: "",
          status: [],
          userIds: ids,
          limit: ids.length || 1,
          offset: 0,
        });
        for (const u of res.users ?? []) {
          map.set(u.id, {
            userId: u.id,
            account: u.account ?? "",
            email: u.email ?? "",
            status: u.status ?? "",
          });
        }
        return map;
      } catch (err) {
        logger.warn(`AuthAdminClient|resolveUsersByIds|error=${String(err)}`);
        return new Map();
      }
    },

    async searchUserIds(term: string, limit: number): Promise<string[]> {
      const q = term.trim();
      if (!q) return [];
      try {
        const res = await adminListUsers({
          search: q,
          status: [],
          userIds: [],
          limit: Math.max(limit, 1),
          offset: 0,
        });
        return (res.users ?? []).map((u) => u.id).filter(Boolean);
      } catch (err) {
        logger.warn(`AuthAdminClient|searchUserIds|error=${String(err)}`);
        return [];
      }
    },
  };
}

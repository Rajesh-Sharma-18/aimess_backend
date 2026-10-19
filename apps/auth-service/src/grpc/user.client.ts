import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeGrpcCallWithDeadline } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import {
  toLoginAccountPreview,
  type LoginAccountPreview,
  type UserSnapshot,
} from "../lib/login-account-preview.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  currentDir,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

const LOOKUP_TIMEOUT_MS = 1500;

let _client: grpc.Client | null = null;

function getClient(): grpc.Client {
  if (!_client) {
    const pkgDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
    const ServiceCtor = (proto["user"] as grpc.GrpcObject)[
      "UserService"
    ] as grpc.ServiceClientConstructor;
    _client = new ServiceCtor(
      env.USER_GRPC_URL,
      grpc.credentials.createInsecure()
    );
  }
  return _client;
}

/** Null on any failure: the caller answers without the preview, never fails. */
export async function getLoginAccountPreview(
  userId: string
): Promise<LoginAccountPreview | null> {
  try {
    const { users } = await makeGrpcCallWithDeadline<
      { userIds: string[] },
      { users?: UserSnapshot[] }
    >(
      getClient(),
      "bulkGetUserSnapshots",
      { userIds: [userId] },
      Date.now() + LOOKUP_TIMEOUT_MS
    );
    return toLoginAccountPreview(users?.[0]);
  } catch (err) {
    logger.warn(`Login account preview skipped: ${String(err)}`);
    return null;
  }
}

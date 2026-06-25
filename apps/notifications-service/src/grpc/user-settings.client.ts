import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

export interface NotificationSettings {
  chatEnabled: boolean;
  callEnabled: boolean;
  friendRequestEnabled: boolean;
  systemEnabled: boolean;
  communityEnabled: boolean;
  liveStreamEnabled: boolean;
  showPreview: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursDays: number[];
}

export interface UserSettingsClient {
  getNotificationSettings(userId: string): Promise<NotificationSettings>;
}

export function createUserSettingsClient(): UserSettingsClient {
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
  const client = new ServiceCtor(
    env.USER_SERVICE_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const getSettingsBreaker = makeBreaker(
    "user.getNotificationSettings",
    (userId: string) =>
      makeGrpcCall<{ userId: string }, NotificationSettings>(
        client,
        "getNotificationSettings",
        { userId }
      )
  );

  return {
    getNotificationSettings: (userId) => getSettingsBreaker.fire(userId),
  };
}

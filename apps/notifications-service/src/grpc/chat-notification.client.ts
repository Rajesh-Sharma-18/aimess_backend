import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/notification.proto"
);

export interface CreateNotificationParams {
  userId: string;
  actorId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface ChatNotificationClient {
  createNotification(p: CreateNotificationParams): Promise<{ id: string }>;
}

export function createChatNotificationClient(): ChatNotificationClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["notification"] as grpc.GrpcObject)[
    "NotificationService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.CHAT_SERVICE_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const createBreaker = makeBreaker(
    "chat.createNotification",
    (p: CreateNotificationParams) =>
      makeGrpcCall<unknown, { id: string }>(client, "createNotification", {
        userId: p.userId,
        actorId: p.actorId ?? "",
        type: p.type,
        title: p.title,
        body: p.body,
        data: p.data ?? {},
      })
  );

  return {
    createNotification: (p) => createBreaker.fire(p),
  };
}

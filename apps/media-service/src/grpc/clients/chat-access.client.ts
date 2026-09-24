import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/messaging.proto"
);

export type MediaAccessScope = "PRIVATE_CHAT" | "GROUP_CHAT" | "COMMUNITY_CHAT";

export interface CheckMediaAccessParams {
  userId: string;
  scope: MediaAccessScope;
  resourceId: string;
  /** The object being downloaded. Omitted on the UPLOAD path, where no object
   *  exists yet and membership is the whole question. */
  objectKey?: string;
  /** Upload instant of that object, epoch ms. Lets chat-service apply a GROUP's
   *  per-member history boundary to the attachment, not just room membership. */
  objectCreatedAt?: number;
}

export interface ChatAccessClient {
  checkMediaAccess(p: CheckMediaAccessParams): Promise<boolean>;
}

/**
 * Outbound gRPC client to chat-service's MessagingService.CheckMediaAccess.
 * media-service calls it to authorize a chat-scoped attachment download against
 * room/group/community membership (the object key alone does not encode the
 * resource). Wrapped in an opossum breaker like the other cross-service clients.
 *
 * FAIL-CLOSED: if the breaker is open or the call errors, access is DENIED — a
 * membership check that cannot complete must never grant access.
 */
export function createChatAccessClient(): ChatAccessClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["messaging"] as grpc.GrpcObject)[
    "MessagingService"
  ] as grpc.ServiceClientConstructor;

  const client = new ServiceCtor(
    env.CHAT_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const breaker = makeBreaker(
    "chat.checkMediaAccess",
    (p: CheckMediaAccessParams) =>
      makeGrpcCall<unknown, { allowed: boolean }>(client, "checkMediaAccess", {
        userId: p.userId,
        scope: p.scope,
        resourceId: p.resourceId,
        objectKey: p.objectKey ?? "",
        objectCreatedAt: p.objectCreatedAt ?? 0,
      }),
    { timeout: 2000 }
  );

  return {
    async checkMediaAccess(p) {
      try {
        const res = await breaker.fire(p);
        return res?.allowed === true;
      } catch {
        return false;
      }
    },
  };
}

let singleton: ChatAccessClient | null = null;

/** Lazily-created singleton (proto is loaded + socket opened on first use). */
export function getChatAccessClient(): ChatAccessClient {
  if (!singleton) singleton = createChatAccessClient();
  return singleton;
}

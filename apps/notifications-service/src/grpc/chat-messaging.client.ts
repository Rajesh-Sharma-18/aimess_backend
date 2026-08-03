import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

export interface CheckPrivateMuteParams {
  roomId: string;
  userId: string;
}

export interface CheckPrivateMuteResult {
  isMuted: boolean;
  /** epoch ms; 0 = indefinite mute or not muted */
  mutedUntil: number;
}

/** Fail-open value: a muted-check failure must NEVER suppress a notification. */
const MUTE_FAIL_OPEN: CheckPrivateMuteResult = {
  isMuted: false,
  mutedUntil: 0,
};

export interface ChatMessagingClient {
  checkPrivateMute(p: CheckPrivateMuteParams): Promise<CheckPrivateMuteResult>;
}

export function createChatMessagingClient(): ChatMessagingClient {
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
    env.CHAT_SERVICE_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const muteBreaker = makeBreaker(
    "chat.checkPrivateMute",
    (p: CheckPrivateMuteParams) =>
      makeGrpcCall<unknown, CheckPrivateMuteResult>(
        client,
        "checkPrivateMute",
        { roomId: p.roomId, userId: p.userId }
      )
  );
  muteBreaker.fallback(() => MUTE_FAIL_OPEN);

  return {
    checkPrivateMute: (p) => muteBreaker.fire(p),
  };
}

/** Module-singleton (same pattern as `communityClient`). */
export const chatMessagingClient: ChatMessagingClient =
  createChatMessagingClient();

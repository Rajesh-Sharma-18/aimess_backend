import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

export interface CheckCommunityMuteParams {
  communityId: string;
  userId: string;
}

export interface CheckCommunityMuteResult {
  isMuted: boolean;
  /** epoch ms; 0 = indefinite mute or not muted */
  mutedUntil: number;
}

/** Fail-open value: a muted-check failure must NEVER suppress a notification. */
const FAIL_OPEN: CheckCommunityMuteResult = { isMuted: false, mutedUntil: 0 };

export interface CheckCommunityNotificationPrefParams {
  communityId: string;
  userId: string;
  field: "chatEnabled" | "streamEnabled" | "announcementEnabled";
}

export interface CheckCommunityNotificationPrefResult {
  enabled: boolean;
}

/** Fail-open value: an oracle outage must NEVER suppress a notification. */
const PREF_FAIL_OPEN: CheckCommunityNotificationPrefResult = { enabled: true };

export interface CommunityClient {
  checkCommunityMute(
    p: CheckCommunityMuteParams
  ): Promise<CheckCommunityMuteResult>;
  checkCommunityNotificationPref(
    p: CheckCommunityNotificationPrefParams
  ): Promise<CheckCommunityNotificationPrefResult>;
}

export function createCommunityClient(): CommunityClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.COMMUNITY_SERVICE_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const muteBreaker = makeBreaker(
    "community.checkCommunityMute",
    (p: CheckCommunityMuteParams) =>
      makeGrpcCall<unknown, CheckCommunityMuteResult>(
        client,
        "checkCommunityMute",
        {
          communityId: p.communityId,
          userId: p.userId,
        }
      )
  );
  // FAIL-OPEN: override the shared breaker's default (throwing) fallback so any
  // failure (timeout / open circuit / INTERNAL) resolves to "not muted" instead
  // of rejecting — a mute-oracle outage must never suppress notifications.
  muteBreaker.fallback(() => FAIL_OPEN);

  const prefBreaker = makeBreaker(
    "community.checkCommunityNotificationPref",
    (p: CheckCommunityNotificationPrefParams) =>
      makeGrpcCall<unknown, CheckCommunityNotificationPrefResult>(
        client,
        "checkCommunityNotificationPref",
        {
          communityId: p.communityId,
          userId: p.userId,
          field: p.field,
        }
      )
  );
  // FAIL-OPEN: same rationale as the mute breaker above — an oracle outage
  // must never suppress a notification.
  prefBreaker.fallback(() => PREF_FAIL_OPEN);

  return {
    checkCommunityMute: (p) => muteBreaker.fire(p),
    checkCommunityNotificationPref: (p) => prefBreaker.fire(p),
  };
}

/** Module-singleton (created once, like `chatNotificationClient`). */
export const communityClient: CommunityClient = createCommunityClient();

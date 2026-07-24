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
const MUTE_FAIL_OPEN: CheckCommunityMuteResult = {
  isMuted: false,
  mutedUntil: 0,
};

export interface CheckCommunityNotificationPrefParams {
  communityId: string;
  userId: string;
  field: "chatEnabled" | "streamEnabled" | "announcementEnabled";
}

export interface CheckCommunityNotificationPrefResult {
  enabled: boolean;
}

/**
 * Fail-CLOSED for preference+membership oracle: an outage must NOT push to
 * former members. Prefer wrongly suppressing a push over notifying a LEFT user.
 */
const PREF_FAIL_CLOSED: CheckCommunityNotificationPrefResult = {
  enabled: false,
};

export interface CheckCommunityMembershipParams {
  communityId: string;
  userId: string;
}

export interface CheckCommunityMembershipResult {
  /** True only when the user has an ACTIVE membership row. */
  isMember: boolean;
  isBanned: boolean;
  status: string;
  role: string;
}

/** Fail-CLOSED: treat oracle outages as "not a member" so FCM never leaks. */
const MEMBERSHIP_FAIL_CLOSED: CheckCommunityMembershipResult = {
  isMember: false,
  isBanned: false,
  status: "",
  role: "",
};

export interface GetCommunityActiveMemberIdsParams {
  communityId: string;
}

export interface GetCommunityActiveMemberIdsResult {
  userIds: string[];
}

/** Fail-CLOSED: empty roster → no community message pushes during an outage. */
const ACTIVE_MEMBERS_FAIL_CLOSED: GetCommunityActiveMemberIdsResult = {
  userIds: [],
};

export interface CommunityClient {
  checkCommunityMute(
    p: CheckCommunityMuteParams
  ): Promise<CheckCommunityMuteResult>;
  checkCommunityNotificationPref(
    p: CheckCommunityNotificationPrefParams
  ): Promise<CheckCommunityNotificationPrefResult>;
  checkCommunityMembership(
    p: CheckCommunityMembershipParams
  ): Promise<CheckCommunityMembershipResult>;
  getCommunityActiveMemberIds(
    p: GetCommunityActiveMemberIdsParams
  ): Promise<GetCommunityActiveMemberIdsResult>;
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
  muteBreaker.fallback(() => MUTE_FAIL_OPEN);

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
  // FAIL-CLOSED: this oracle also encodes ACTIVE membership. An outage must
  // not re-open the door for LEFT/BANNED recipients.
  prefBreaker.fallback(() => PREF_FAIL_CLOSED);

  const membershipBreaker = makeBreaker(
    "community.checkCommunityMembership",
    (p: CheckCommunityMembershipParams) =>
      makeGrpcCall<unknown, CheckCommunityMembershipResult>(
        client,
        "checkCommunityMembership",
        {
          communityId: p.communityId,
          userId: p.userId,
        }
      )
  );
  membershipBreaker.fallback(() => MEMBERSHIP_FAIL_CLOSED);

  const activeMembersBreaker = makeBreaker(
    "community.getCommunityActiveMemberIds",
    (p: GetCommunityActiveMemberIdsParams) =>
      makeGrpcCall<unknown, GetCommunityActiveMemberIdsResult>(
        client,
        "getCommunityActiveMemberIds",
        { communityId: p.communityId }
      )
  );
  activeMembersBreaker.fallback(() => ACTIVE_MEMBERS_FAIL_CLOSED);

  return {
    checkCommunityMute: (p) => muteBreaker.fire(p),
    checkCommunityNotificationPref: (p) => prefBreaker.fire(p),
    checkCommunityMembership: (p) => membershipBreaker.fire(p),
    getCommunityActiveMemberIds: (p) => activeMembersBreaker.fire(p),
  };
}

/** Module-singleton (created once, like `chatNotificationClient`). */
export const communityClient: CommunityClient = createCommunityClient();

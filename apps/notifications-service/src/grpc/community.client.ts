import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

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

export interface CommunityBrief {
  communityId: string;
  name: string;
  /** Presigned avatar URL, "" when the community has none. */
  avatarUrl: string;
}

/**
 * Fail-open: an unresolved brief only costs the notification its community NAME,
 * so it must never throw and abort (and DLQ) the push.
 */
const BRIEF_FAIL_OPEN: CommunityBrief | null = null;

export interface GetCommunityNotifiableMemberIdsParams {
  communityId: string;
  field: "chatEnabled" | "streamEnabled" | "announcementEnabled";
}

export interface CommunityClient {
  getCommunityNotifiableMemberIds(
    p: GetCommunityNotifiableMemberIdsParams
  ): Promise<GetCommunityActiveMemberIdsResult>;
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
  /**
   * Authoritative community identity (name + presigned avatar) for one id.
   * `null` when the id is unknown or the lookup failed.
   */
  getCommunityBrief(communityId: string): Promise<CommunityBrief | null>;
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

  // Reuses the existing batch enrichment RPC (backoffice livestream list) with a
  // single id — community-service reads it straight off the Community record, so
  // it is the authoritative name, never a cached copy captured at emit time.
  const briefBreaker = makeBreaker(
    "community.getCommunityBrief",
    async (communityId: string) => {
      const res = await makeGrpcCall<
        unknown,
        { communities?: CommunityBrief[] }
      >(client, "adminGetCommunitiesByIds", { communityIds: [communityId] });
      return res.communities?.[0] ?? null;
    }
  );
  briefBreaker.fallback(() => BRIEF_FAIL_OPEN);
  const notifiableBreaker = makeBreaker(
    "community.getCommunityNotifiableMemberIds",
    (p: GetCommunityNotifiableMemberIdsParams) =>
      makeGrpcCall<unknown, GetCommunityActiveMemberIdsResult>(
        client,
        "getCommunityNotifiableMemberIds",
        { communityId: p.communityId, field: p.field }
      )
  );
  // Loud: this fallback suppresses an ENTIRE community fan-out, and the breaker
  // holds open for resetTimeout (10s) — so one blip silences every community push
  // in that window. Silent before, it was indistinguishable from "roster is
  // legitimately empty", which is exactly how dropped pushes went undiagnosed.
  notifiableBreaker.fallback(() => {
    logger.warn(
      "community.getCommunityNotifiableMemberIds fail-closed — community push fan-out SUPPRESSED"
    );
    return ACTIVE_MEMBERS_FAIL_CLOSED;
  });

  return {
    getCommunityNotifiableMemberIds: (p) => notifiableBreaker.fire(p),
    checkCommunityMute: (p) => muteBreaker.fire(p),
    checkCommunityNotificationPref: (p) => prefBreaker.fire(p),
    checkCommunityMembership: (p) => membershipBreaker.fire(p),
    getCommunityActiveMemberIds: (p) => activeMembersBreaker.fire(p),
    getCommunityBrief: (communityId) => briefBreaker.fire(communityId),
  };
}

/** Module-singleton (created once, like `chatNotificationClient`). */
export const communityClient: CommunityClient = createCommunityClient();

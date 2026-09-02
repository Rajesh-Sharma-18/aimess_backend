import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

interface ValidateMembershipResult {
  isMember: boolean;
  role: string;
  status: string;
  /** True when the community is owner-CLOSED or platform-SUSPENDED. */
  isCommunityClosed: boolean;
}

interface CheckMuteResult {
  isMuted: boolean;
  mutedUntil: number; // epoch ms; 0 = indefinite or not muted
}

interface CheckBanResult {
  isBanned: boolean;
  /** True when the user is an ACTIVE member of the community. */
  isMember: boolean;
  /** True when the community is PUBLIC (non-members may read it). */
  isPublicCommunity: boolean;
}

/** Mirrors community.proto's ModerationActionResponse (mute/unmute share it). */
interface ModerationActionResult {
  ok: boolean;
  communityId: string;
  targetUserId: string;
  errorCode: string;
  mutedUntil: number; // only populated by muteMember; epoch ms, 0 = indefinite
}

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
  env.COMMUNITY_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

const validateMembershipBreaker: Breaker<
  { communityId: string; userId: string },
  ValidateMembershipResult
> = makeBreaker(
  "community.validateMembership",
  (args: { communityId: string; userId: string }) =>
    call<{ communityId: string; userId: string }, ValidateMembershipResult>(
      "validateMembership",
      args
    )
);

const checkMuteBreaker: Breaker<
  { communityId: string; userId: string },
  CheckMuteResult
> = makeBreaker(
  "community.checkCommunityMute",
  (args: { communityId: string; userId: string }) =>
    call<{ communityId: string; userId: string }, CheckMuteResult>(
      "checkCommunityMute",
      args
    )
);

const checkBanBreaker: Breaker<
  { communityId: string; userId: string },
  {
    isMember: boolean;
    isBanned: boolean;
    status: string;
    role: string;
    isPublicCommunity: boolean;
  }
> = makeBreaker(
  "community.checkCommunityMembership",
  (args: { communityId: string; userId: string }) =>
    call<
      { communityId: string; userId: string },
      {
        isMember: boolean;
        isBanned: boolean;
        status: string;
        role: string;
        // Already on the wire (community.proto `is_public_community`); only
        // this TypeScript type dropped it, so callers could not tell a private
        // community from a public one.
        isPublicCommunity: boolean;
      }
    >("checkCommunityMembership", args)
);

const muteMemberBreaker: Breaker<
  {
    communityId: string;
    actorId: string;
    targetUserId: string;
    durationMinutes: number;
    reason: string;
  },
  ModerationActionResult
> = makeBreaker("community.muteMember", (args) =>
  call<typeof args, ModerationActionResult>("muteMember", args)
);

const unmuteMemberBreaker: Breaker<
  { communityId: string; actorId: string; targetUserId: string },
  ModerationActionResult
> = makeBreaker("community.unmuteMember", (args) =>
  call<typeof args, ModerationActionResult>("unmuteMember", args)
);

const banMemberBreaker: Breaker<
  {
    communityId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
  },
  ModerationActionResult
> = makeBreaker("community.banMember", (args) =>
  call<typeof args, ModerationActionResult>("banMember", args)
);

const unbanMemberBreaker: Breaker<
  { communityId: string; actorId: string; targetUserId: string },
  ModerationActionResult
> = makeBreaker("community.unbanMember", (args) =>
  call<typeof args, ModerationActionResult>("unbanMember", args)
);

/**
 * Circuit-broken community-service client. Backs the go-live + join gates.
 *
 * Throws on circuit-open / gRPC error — callers decide policy:
 *   - createStream: fail-closed (deny go-live when membership unverifiable)
 *   - checkAccess:  fail-open  (allow viewing so a community-service outage
 *                              doesn't black out all live streams)
 *   - checkMute:    fail-open  (a moderator's mute must not be *required* to
 *                              keep chat flowing during a community-service outage)
 *   - muteMember/unmuteMember: throw on circuit-open / gRPC error (a real
 *     write action — the caller must know it didn't happen); a business
 *     rejection (unauthorized, self-target, etc.) comes back as ok:false
 *     with errorCode, not a throw.
 *   - checkBan:     fail-open  (consistent with every other community-service
 *                              read here — an outage never blacks out viewing
 *                              on its own; the local per-stream ban remains a
 *                              synchronous, always-available hard block)
 *   - banMember/unbanMember: throw on circuit-open / gRPC error, same as mute.
 */
export const communityGrpcClient = {
  async validateMembership(
    communityId: string,
    userId: string
  ): Promise<ValidateMembershipResult> {
    const result = await validateMembershipBreaker.fire({
      communityId,
      userId,
    });
    return {
      isMember: Boolean(result?.isMember),
      role: result?.role ?? "",
      status: result?.status ?? "",
      isCommunityClosed: Boolean(result?.isCommunityClosed),
    };
  },

  /** Moderator-applied community mute (distinct from per-user notification mute). */
  async checkMute(
    communityId: string,
    userId: string
  ): Promise<CheckMuteResult> {
    const result = await checkMuteBreaker.fire({ communityId, userId });
    return {
      isMuted: Boolean(result?.isMuted),
      mutedUntil: Number(result?.mutedUntil ?? 0),
    };
  },

  /**
   * Write-through to the single community mute record. `durationMinutes<=0`
   * means indefinite. Authorization (MODERATOR+ rank, self/admin guards) is
   * enforced entirely on the community-service side.
   */
  async muteMember(
    communityId: string,
    actorId: string,
    targetUserId: string,
    durationMinutes: number,
    reason: string
  ): Promise<ModerationActionResult> {
    const result = await muteMemberBreaker.fire({
      communityId,
      actorId,
      targetUserId,
      durationMinutes,
      reason,
    });
    return {
      ok: Boolean(result?.ok),
      communityId: result?.communityId ?? communityId,
      targetUserId: result?.targetUserId ?? targetUserId,
      errorCode: result?.errorCode ?? "",
      mutedUntil: Number(result?.mutedUntil ?? 0),
    };
  },

  async unmuteMember(
    communityId: string,
    actorId: string,
    targetUserId: string
  ): Promise<ModerationActionResult> {
    const result = await unmuteMemberBreaker.fire({
      communityId,
      actorId,
      targetUserId,
    });
    return {
      ok: Boolean(result?.ok),
      communityId: result?.communityId ?? communityId,
      targetUserId: result?.targetUserId ?? targetUserId,
      errorCode: result?.errorCode ?? "",
      mutedUntil: 0,
    };
  },

  /**
   * Community-wide ban status (ADMIN-applied in community-service) — distinct
   * from the stream-local `LivestreamBan` table. Fail-open: an outage never
   * blacks out viewing on its own.
   */
  async checkBan(communityId: string, userId: string): Promise<CheckBanResult> {
    const result = await checkBanBreaker.fire({ communityId, userId });
    return {
      isBanned: Boolean(result?.isBanned),
      // Surfaced so callers can distinguish "not a member of a PRIVATE
      // community" from "not a member of a public one" — the listing gate needs
      // both, and this RPC already returns them.
      isMember: Boolean(result?.isMember),
      isPublicCommunity: Boolean(result?.isPublicCommunity),
    };
  },

  /**
   * Write-through to the single community ban record. Authorization (ADMIN
   * only — stricter than mute's MODERATOR+) is enforced entirely on the
   * community-service side.
   */
  async banMember(
    communityId: string,
    actorId: string,
    targetUserId: string,
    reason: string
  ): Promise<ModerationActionResult> {
    const result = await banMemberBreaker.fire({
      communityId,
      actorId,
      targetUserId,
      reason,
    });
    return {
      ok: Boolean(result?.ok),
      communityId: result?.communityId ?? communityId,
      targetUserId: result?.targetUserId ?? targetUserId,
      errorCode: result?.errorCode ?? "",
      mutedUntil: 0,
    };
  },

  async unbanMember(
    communityId: string,
    actorId: string,
    targetUserId: string
  ): Promise<ModerationActionResult> {
    const result = await unbanMemberBreaker.fire({
      communityId,
      actorId,
      targetUserId,
    });
    return {
      ok: Boolean(result?.ok),
      communityId: result?.communityId ?? communityId,
      targetUserId: result?.targetUserId ?? targetUserId,
      errorCode: result?.errorCode ?? "",
      mutedUntil: 0,
    };
  },
};

export type CommunityGrpcClient = typeof communityGrpcClient;

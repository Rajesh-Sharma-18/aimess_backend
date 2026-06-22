/**
 * Centralized community ban / role gate (`src/lib/community-authz.ts`).
 * `assertNotBanned` is the single source of truth for the BANNED check used by
 * access / join / invite / view paths.
 */
import { ForbiddenError } from "@aimess/errors";

import {
  assertCommunityRole,
  assertNotBanned,
} from "../../src/lib/community-authz.js";
import {
  CommunityMemberRole,
  CommunityMemberStatus,
} from "../../src/generated/prisma/index.js";

describe("assertNotBanned", () => {
  it("throws COMMUNITY_JOIN_BANNED for a BANNED membership", () => {
    expect(() =>
      assertNotBanned({ status: CommunityMemberStatus.BANNED })
    ).toThrow(ForbiddenError);
    try {
      assertNotBanned({ status: CommunityMemberStatus.BANNED });
    } catch (e) {
      expect((e as ForbiddenError).message).toBe("COMMUNITY_JOIN_BANNED");
    }
  });

  it("passes for null (non-member)", () => {
    expect(() => assertNotBanned(null)).not.toThrow();
  });

  it("passes for ACTIVE / LEFT / PENDING (non-banned) statuses", () => {
    for (const status of [
      CommunityMemberStatus.ACTIVE,
      CommunityMemberStatus.LEFT,
      CommunityMemberStatus.PENDING,
    ]) {
      expect(() => assertNotBanned({ status })).not.toThrow();
    }
  });
});

describe("assertCommunityRole (regression — banned/role gate unchanged)", () => {
  it("throws for a BANNED member even with ADMIN role", () => {
    expect(() =>
      assertCommunityRole(
        {
          status: CommunityMemberStatus.BANNED,
          role: CommunityMemberRole.ADMIN,
        },
        CommunityMemberRole.MEMBER
      )
    ).toThrow(ForbiddenError);
  });

  it("passes for an ACTIVE member meeting the min role", () => {
    expect(() =>
      assertCommunityRole(
        {
          status: CommunityMemberStatus.ACTIVE,
          role: CommunityMemberRole.MODERATOR,
        },
        CommunityMemberRole.MODERATOR
      )
    ).not.toThrow();
  });
});

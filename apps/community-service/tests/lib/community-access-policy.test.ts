/**
 * Centralized community write/join gate (`src/lib/community-access-policy.ts`).
 * Single source of truth for "is this community writable / joinable right now?"
 * — combines the owner `status` (CLOSED) and platform `moderationStatus`
 * (SUSPENDED) axes, with legacy-missing-status treated as ACTIVE.
 */
import { ForbiddenError } from "@aimess/errors";

// This suite tests the REAL policy module — bypass the global auto-mock
// (tests/setup/global-mocks.ts stubs assertWritable/assertJoinable as no-ops
// for every other suite so fixtures don't need to care about community status).
jest.unmock("../../src/lib/community-access-policy.js");

import {
  assertWritable,
  assertJoinable,
  deriveStatus,
  isEffectivelyClosed,
  isOwnerClosed,
} from "../../src/lib/community-access-policy.js";
import {
  CommunityModerationStatus,
  CommunityStatus,
} from "../../src/generated/prisma/index.js";

const ACTIVE_MOD = { moderationStatus: CommunityModerationStatus.ACTIVE };

describe("deriveStatus (serialization helper)", () => {
  it("returns CLOSED when status is CLOSED", () => {
    expect(deriveStatus({ status: CommunityStatus.CLOSED })).toBe("CLOSED");
  });

  it("returns ACTIVE when status is ACTIVE", () => {
    expect(deriveStatus({ status: CommunityStatus.ACTIVE })).toBe("ACTIVE");
  });

  it("coalesces missing/null status to ACTIVE (backward-compat)", () => {
    expect(deriveStatus({})).toBe("ACTIVE");
    expect(deriveStatus({ status: null })).toBe("ACTIVE");
  });
});

describe("isOwnerClosed", () => {
  it("true only for CLOSED; legacy-missing ⇒ false", () => {
    expect(isOwnerClosed({ status: CommunityStatus.CLOSED })).toBe(true);
    expect(isOwnerClosed({ status: CommunityStatus.ACTIVE })).toBe(false);
    expect(isOwnerClosed({})).toBe(false);
  });
});

describe("assertWritable", () => {
  it("passes for an open community (ACTIVE status + ACTIVE moderation)", () => {
    expect(() =>
      assertWritable({ status: CommunityStatus.ACTIVE, ...ACTIVE_MOD })
    ).not.toThrow();
  });

  it("passes for a legacy community with no status field", () => {
    expect(() => assertWritable({ ...ACTIVE_MOD })).not.toThrow();
  });

  it("throws COMMUNITY_IS_CLOSED when owner-closed (status=CLOSED)", () => {
    try {
      assertWritable({ status: CommunityStatus.CLOSED, ...ACTIVE_MOD });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).message).toBe("COMMUNITY_IS_CLOSED");
    }
  });

  it("throws COMMUNITY_SUSPENDED when platform-suspended", () => {
    try {
      assertWritable({
        status: CommunityStatus.ACTIVE,
        moderationStatus: CommunityModerationStatus.SUSPENDED,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).message).toBe("COMMUNITY_SUSPENDED");
    }
  });

  it("prefers the CLOSED error when BOTH axes block", () => {
    try {
      assertWritable({
        status: CommunityStatus.CLOSED,
        moderationStatus: CommunityModerationStatus.SUSPENDED,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ForbiddenError).message).toBe("COMMUNITY_IS_CLOSED");
    }
  });
});

describe("assertJoinable", () => {
  it("is the same gate as assertWritable", () => {
    expect(() =>
      assertJoinable({ status: CommunityStatus.CLOSED, ...ACTIVE_MOD })
    ).toThrow(ForbiddenError);
    expect(() =>
      assertJoinable({ status: CommunityStatus.ACTIVE, ...ACTIVE_MOD })
    ).not.toThrow();
  });
});

describe("isEffectivelyClosed", () => {
  it("true when either axis is closed/suspended", () => {
    expect(
      isEffectivelyClosed({ status: CommunityStatus.CLOSED, ...ACTIVE_MOD })
    ).toBe(true);
    expect(
      isEffectivelyClosed({
        status: CommunityStatus.ACTIVE,
        moderationStatus: CommunityModerationStatus.SUSPENDED,
      })
    ).toBe(true);
    expect(
      isEffectivelyClosed({ status: CommunityStatus.ACTIVE, ...ACTIVE_MOD })
    ).toBe(false);
  });
});

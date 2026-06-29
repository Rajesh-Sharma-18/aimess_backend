/**
 * Moderation-mute write gate — `isCommunityMemberMuted` / `assertCommunityMemberNotMuted`.
 *
 * Pure, allocation-free checks over an already-loaded RoomMember row (the mute
 * state is mirrored from community-service by the `community.member.mute_synced`
 * consumer). Lazy local expiry: a timed mute auto-lifts the instant `mutedUntil`
 * passes, even before the auto-unmute sweep clears the flag. Indefinite mute =
 * `isMuted:true` with `mutedUntil:null`.
 */
import { ForbiddenError } from "@aimess/errors";

import {
  isCommunityMemberMuted,
  assertCommunityMemberNotMuted,
} from "../../src/lib/access-guard.js";

type MuteRow = { isMuted: boolean; mutedUntil: Date | null };

describe("isCommunityMemberMuted", () => {
  it("false when the member is not muted", () => {
    expect(isCommunityMemberMuted({ isMuted: false, mutedUntil: null })).toBe(
      false
    );
  });

  it("true for an indefinite mute (isMuted, mutedUntil null)", () => {
    expect(isCommunityMemberMuted({ isMuted: true, mutedUntil: null })).toBe(
      true
    );
  });

  it("true while a timed mute is still in the future", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isCommunityMemberMuted({ isMuted: true, mutedUntil: future })).toBe(
      true
    );
  });

  it("false once a timed mute has passed (lazy local expiry)", () => {
    const past = new Date(Date.now() - 1000);
    expect(isCommunityMemberMuted({ isMuted: true, mutedUntil: past })).toBe(
      false
    );
  });

  it("false for a null/absent member row", () => {
    expect(isCommunityMemberMuted(null)).toBe(false);
    expect(isCommunityMemberMuted(undefined)).toBe(false);
  });

  it("false when isMuted flag is stale-false even with a future mutedUntil", () => {
    // The flag is authoritative; an unmute clears isMuted regardless of mutedUntil.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isCommunityMemberMuted({ isMuted: false, mutedUntil: future })).toBe(
      false
    );
  });
});

describe("assertCommunityMemberNotMuted", () => {
  const muted: MuteRow = { isMuted: true, mutedUntil: null };
  const notMuted: MuteRow = { isMuted: false, mutedUntil: null };

  it("throws CHAT_MUTED_IN_COMMUNITY for a muted member", () => {
    expect(() => assertCommunityMemberNotMuted(muted)).toThrow(ForbiddenError);
    try {
      assertCommunityMemberNotMuted(muted);
    } catch (e) {
      expect((e as ForbiddenError).message).toBe("CHAT_MUTED_IN_COMMUNITY");
    }
  });

  it("passes for a non-muted member", () => {
    expect(() => assertCommunityMemberNotMuted(notMuted)).not.toThrow();
  });

  it("passes for an expired timed mute", () => {
    const past = new Date(Date.now() - 1000);
    expect(() =>
      assertCommunityMemberNotMuted({ isMuted: true, mutedUntil: past })
    ).not.toThrow();
  });
});

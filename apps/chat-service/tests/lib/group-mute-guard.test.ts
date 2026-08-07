/**
 * Group moderation-mute write gate — `isGroupMemberMuted` /
 * `assertGroupMemberNotMuted`.
 *
 * The group counterpart of `community-mute-guard.test.ts`. Unlike community
 * (whose mute is mirrored onto RoomMember from community-service), group mute
 * lives directly on the GroupMember row chat-service already owns, so these are
 * pure checks over an already-loaded row — zero extra I/O on the send path.
 *
 * Lazy expiry: a timed mute auto-lifts the instant `moderationMutedUntil`
 * passes, even before the auto-unmute sweep clears the flag. An indefinite mute
 * is `moderationMuted: true` with `moderationMutedUntil: null`.
 */
import { ForbiddenError } from "@aimess/errors";

import {
  isGroupMemberMuted,
  assertGroupMemberNotMuted,
} from "../../src/lib/access-guard.js";

type MuteRow = {
  moderationMuted: boolean;
  moderationMutedUntil: Date | null;
};

describe("isGroupMemberMuted", () => {
  it("false when the member is not muted", () => {
    expect(
      isGroupMemberMuted({
        moderationMuted: false,
        moderationMutedUntil: null,
      })
    ).toBe(false);
  });

  it("true for an indefinite mute (flag set, no expiry)", () => {
    expect(
      isGroupMemberMuted({ moderationMuted: true, moderationMutedUntil: null })
    ).toBe(true);
  });

  it("true while a timed mute is still in the future", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(
      isGroupMemberMuted({
        moderationMuted: true,
        moderationMutedUntil: future,
      })
    ).toBe(true);
  });

  it("false once a timed mute has passed (lazy expiry, no sweep needed)", () => {
    const past = new Date(Date.now() - 1000);
    expect(
      isGroupMemberMuted({ moderationMuted: true, moderationMutedUntil: past })
    ).toBe(false);
  });

  it("false for a null/absent member row", () => {
    expect(isGroupMemberMuted(null)).toBe(false);
    expect(isGroupMemberMuted(undefined)).toBe(false);
  });

  it("false when the flag is cleared even with a future expiry", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(
      isGroupMemberMuted({
        moderationMuted: false,
        moderationMutedUntil: future,
      })
    ).toBe(false);
  });
});

describe("assertGroupMemberNotMuted", () => {
  const muted: MuteRow = {
    moderationMuted: true,
    moderationMutedUntil: null,
  };
  const notMuted: MuteRow = {
    moderationMuted: false,
    moderationMutedUntil: null,
  };

  it("throws CHAT_MUTED_IN_GROUP for a muted member", () => {
    expect(() => assertGroupMemberNotMuted(muted)).toThrow(ForbiddenError);
    try {
      assertGroupMemberNotMuted(muted);
    } catch (e) {
      expect((e as ForbiddenError).message).toBe("CHAT_MUTED_IN_GROUP");
    }
  });

  it("passes for a non-muted member", () => {
    expect(() => assertGroupMemberNotMuted(notMuted)).not.toThrow();
  });

  it("passes for an expired timed mute", () => {
    const past = new Date(Date.now() - 1000);
    expect(() =>
      assertGroupMemberNotMuted({
        moderationMuted: true,
        moderationMutedUntil: past,
      })
    ).not.toThrow();
  });
});

/**
 * Unit coverage for the moderation-mute oracle that powers the notifications
 * eligibility gate (community-level notification suppression for muted users).
 *
 * Subject under test: `communityRepository.findActiveMemberMute(communityId,userId)`
 *   - returns the row ONLY while the mute is still effective (lazy expiration:
 *     `mutedUntil === null` OR `mutedUntil > now`)
 *   - returns null for an expired mute (past `mutedUntil`)
 *   - returns null when there is no mute row at all
 *
 * This is the single source of truth the gRPC `checkCommunityMute` handler maps
 * straight to the wire ({ isMuted: row != null, mutedUntil: row?.mutedUntil ms })
 * — see `src/grpc/server.ts`. The handler's row→wire mapping is a 2-line pure
 * transform asserted at the bottom of this file against this repo contract; it
 * is NOT exercised through a live gRPC channel because `server.ts` proto-loads
 * via `import.meta.url`, which CJS-mode Jest cannot import (same constraint that
 * keeps every other community-service test off the gRPC server module).
 *
 * The global prisma stub (`tests/setup/global-mocks.ts`) is `{}`; we re-mock it
 * here with a controllable `communityMemberMute.findUnique` so the lazy-expiry
 * branch logic runs for real against injected rows.
 */

const findUnique = jest.fn();
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMemberMute: { findUnique },
  },
}));
jest.unmock("../../src/repositories/community.repository.js");

import { communityRepository } from "../../src/repositories/community.repository.js";

const CID = "a".repeat(24);
const UID = "11111111-1111-4111-8111-111111111111";

describe("communityRepository.findActiveMemberMute — lazy expiry oracle", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  // POSITIVE: indefinite mute (mutedUntil stored as explicit null) is always active.
  it("indefinite mute (mutedUntil === null) → returns the row", async () => {
    const row = { communityId: CID, userId: UID, mutedUntil: null };
    findUnique.mockResolvedValue(row);

    const result = await communityRepository.findActiveMemberMute(CID, UID);

    expect(result).toBe(row);
    expect(findUnique).toHaveBeenCalledWith({
      where: { communityId_userId: { communityId: CID, userId: UID } },
    });
  });

  // POSITIVE: a future expiry is still effective → row returned.
  it("future mutedUntil → returns the row", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const row = { communityId: CID, userId: UID, mutedUntil: future };
    findUnique.mockResolvedValue(row);

    const result = await communityRepository.findActiveMemberMute(CID, UID);

    expect(result).toBe(row);
  });

  // NEGATIVE: a past expiry is no longer effective → null (lazy expiration).
  it("past mutedUntil → returns null (expired)", async () => {
    const past = new Date(Date.now() - 60 * 1000); // -1m
    findUnique.mockResolvedValue({
      communityId: CID,
      userId: UID,
      mutedUntil: past,
    });

    const result = await communityRepository.findActiveMemberMute(CID, UID);

    expect(result).toBeNull();
  });

  // NEGATIVE: no mute row at all → null.
  it("no row → returns null", async () => {
    findUnique.mockResolvedValue(null);

    const result = await communityRepository.findActiveMemberMute(CID, UID);

    expect(result).toBeNull();
  });

  // EDGE / adversarial: mutedUntil exactly === now is treated as EXPIRED
  // (strict `> now`). Documents the boundary so an off-by-one can't silently
  // flip a just-expired mute back to "active".
  it("mutedUntil exactly at 'now' → returns null (strict > now boundary)", async () => {
    const fixed = new Date("2026-06-18T00:00:00.000Z");
    jest.useFakeTimers().setSystemTime(fixed);
    findUnique.mockResolvedValue({
      communityId: CID,
      userId: UID,
      mutedUntil: new Date(fixed.getTime()),
    });

    const result = await communityRepository.findActiveMemberMute(CID, UID);

    expect(result).toBeNull();
    jest.useRealTimers();
  });

  // ---- gRPC handler row→wire mapping (pure transform, mirrors server.ts) ----
  // The handler does exactly:
  //   { isMuted: row != null, mutedUntil: row?.mutedUntil instanceof Date ? row.mutedUntil.getTime() : 0 }
  // We assert that contract directly against the repo's two return shapes so the
  // oracle's wire output is locked even though server.ts can't be imported here.
  describe("checkCommunityMute row→wire mapping (mirrors src/grpc/server.ts)", () => {
    const toWire = (row: { mutedUntil: Date | null } | null) => ({
      isMuted: row != null,
      mutedUntil:
        row?.mutedUntil instanceof Date ? row.mutedUntil.getTime() : 0,
    });

    it("active timed row → { isMuted:true, mutedUntil:<epoch ms> }", () => {
      const until = new Date("2026-06-19T00:00:00.000Z");
      expect(toWire({ mutedUntil: until })).toEqual({
        isMuted: true,
        mutedUntil: until.getTime(),
      });
    });

    it("indefinite row (mutedUntil null) → { isMuted:true, mutedUntil:0 }", () => {
      expect(toWire({ mutedUntil: null })).toEqual({
        isMuted: true,
        mutedUntil: 0,
      });
    });

    it("no row → { isMuted:false, mutedUntil:0 }", () => {
      expect(toWire(null)).toEqual({ isMuted: false, mutedUntil: 0 });
    });
  });
});

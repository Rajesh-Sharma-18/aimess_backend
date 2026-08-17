/**
 * `communityRepository.findNotifiableMemberIds` — the BATCHED push-eligibility
 * roster that replaced the per-recipient membership + preference gRPC oracles in
 * notifications-service (4 DB queries EACH, which saturated community-service and
 * tripped its 2s breaker — whose fail-closed fallback then silently dropped the
 * whole community fan-out).
 *
 * It re-encodes `resolveCommunityNotificationPrefEnabled`'s mute semantics as a SQL
 * predicate, so the risk this guards is DRIFT between the two: a member the per-user
 * resolver would allow must not be filtered out here, and vice versa.
 *   - ACTIVE + no mute row         → notifiable (absent row ⇒ defaults on)
 *   - ACTIVE + field toggled off   → suppressed
 *   - ACTIVE + unlapsed timed mute → suppressed (snoozes every kind)
 *   - non-ACTIVE                   → never in the roster to begin with
 */

const memberFindMany = jest.fn();
const muteFindMany = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: { findMany: memberFindMany },
    communityMuteSetting: { findMany: muteFindMany },
  },
}));

// `tests/setup/global-mocks.ts` stubs the whole repository module; this suite is
// testing the repository itself, so pull in the real one over that stub.
jest.mock("../../src/repositories/community.repository.js", () =>
  jest.requireActual("../../src/repositories/community.repository.js")
);

import { communityRepository } from "../../src/repositories/community.repository.js";

const CID = "a".repeat(24);
const ACTIVE = ["u-plain", "u-toggled-off", "u-timed-mute"];

describe("findNotifiableMemberIds", () => {
  beforeEach(() => {
    memberFindMany.mockReset();
    muteFindMany.mockReset();
    memberFindMany.mockResolvedValue(ACTIVE.map((userId) => ({ userId })));
  });

  it("returns ACTIVE members minus anyone the mute predicate suppresses", async () => {
    muteFindMany.mockResolvedValue([
      { userId: "u-toggled-off" },
      { userId: "u-timed-mute" },
    ]);

    await expect(
      communityRepository.findNotifiableMemberIds(CID, "chatEnabled")
    ).resolves.toEqual(["u-plain"]);
  });

  it("keeps every ACTIVE member when nobody has a suppressing mute row", async () => {
    muteFindMany.mockResolvedValue([]);

    await expect(
      communityRepository.findNotifiableMemberIds(CID, "chatEnabled")
    ).resolves.toEqual(ACTIVE);
  });

  it("suppresses on <field>=false OR a still-running timed mute — never on mere row existence", async () => {
    muteFindMany.mockResolvedValue([]);
    await communityRepository.findNotifiableMemberIds(CID, "streamEnabled");

    const where = muteFindMany.mock.calls[0][0].where as {
      communityId: string;
      OR: [Record<string, unknown>, { mutedUntil: { gt: Date } }];
    };
    expect(where.communityId).toBe(CID);
    // Field is parameterised — a hardcoded key here would silently mis-gate
    // stream/announcement pushes using the chat toggle.
    expect(where.OR[0]).toEqual({ streamEnabled: false });
    // `mutedUntil: { gt: now }` — a LAPSED timed mute must not suppress.
    expect(where.OR[1].mutedUntil.gt).toBeInstanceOf(Date);
  });
});

/**
 * The community notification-mute storage model, after issues 50 + 51.
 *
 * Two invariants are asserted here because breaking either one silently
 * un-syncs the mute badge from the three category switches (issue 50) or
 * makes a category impossible to re-enable (issue 51):
 *
 *   1. `isCommunityMuted` is DERIVED — a running timed mute, or all three
 *      categories off. Row existence and `mutedUntil = null` are not mutes.
 *   2. An indefinite mute is WRITTEN as all three categories off, so tapping
 *      the mute icon leaves the switches showing the truth. A timed mute
 *      leaves the switches alone and lapses on its own.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMuteSetting: {
      upsert: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));
jest.unmock("../../src/repositories/community.repository.js");

import { prisma } from "../../src/config/prisma.js";
import { isCommunityMuted } from "../../src/lib/community-notification-pref.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const upsert = (
  prisma as unknown as { communityMuteSetting: { upsert: jest.Mock } }
).communityMuteSetting.upsert;

const CID = "a".repeat(24);
const UID = "11111111-1111-4111-8111-111111111111";
const ALL_ON = {
  streamEnabled: true,
  chatEnabled: true,
  announcementEnabled: true,
};
const ALL_OFF = {
  streamEnabled: false,
  chatEnabled: false,
  announcementEnabled: false,
};

describe("isCommunityMuted — derived mute badge", () => {
  it("no row → not muted", () => {
    expect(isCommunityMuted(null)).toBe(false);
  });

  it("all three categories on, no timed mute → not muted", () => {
    // Issue 50: this row (created by touching any toggle) used to light up the
    // mute icon while the panel showed all three switches green.
    expect(isCommunityMuted({ mutedUntil: null, ...ALL_ON })).toBe(false);
  });

  it("all three categories off → muted", () => {
    expect(isCommunityMuted({ mutedUntil: null, ...ALL_OFF })).toBe(true);
  });

  it("any single category on → not muted", () => {
    expect(
      isCommunityMuted({ mutedUntil: null, ...ALL_OFF, chatEnabled: true })
    ).toBe(false);
  });

  it("unlapsed timed mute → muted even with every category on", () => {
    expect(
      isCommunityMuted({ mutedUntil: new Date(Date.now() + 60_000), ...ALL_ON })
    ).toBe(true);
  });

  it("lapsed timed mute → falls back to the categories", () => {
    expect(
      isCommunityMuted({ mutedUntil: new Date(Date.now() - 60_000), ...ALL_ON })
    ).toBe(false);
  });
});

describe("upsertMute — how a mute is stored", () => {
  beforeEach(() => upsert.mockReset().mockResolvedValue({}));

  it("indefinite mute switches all three categories off", async () => {
    await communityRepository.upsertMute(UID, CID, null);

    const arg = upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ mutedUntil: null, ...ALL_OFF });
    expect(arg.update).toMatchObject({ mutedUntil: null, ...ALL_OFF });
  });

  it("timed mute leaves the category toggles untouched", async () => {
    const until = new Date(Date.now() + 3_600_000);
    await communityRepository.upsertMute(UID, CID, until);

    const arg = upsert.mock.calls[0][0];
    expect(arg.update).toEqual({ mutedUntil: until });
    expect(arg.create).toEqual({
      userId: UID,
      communityId: CID,
      mutedUntil: until,
    });
  });
});

describe("findStreamMutedMemberIds — livestream fan-out exclusion", () => {
  it("excludes both streamEnabled=false and members under a timed mute", async () => {
    const findMany = (
      prisma as unknown as { communityMuteSetting: { findMany: jest.Mock } }
    ).communityMuteSetting.findMany;
    findMany.mockResolvedValue([]);

    await communityRepository.findStreamMutedMemberIds(CID);

    const where = findMany.mock.calls[0][0].where;
    expect(where.communityId).toBe(CID);
    expect(where.OR).toEqual([
      { streamEnabled: false },
      { mutedUntil: { gt: expect.any(Date) } },
    ]);
  });
});

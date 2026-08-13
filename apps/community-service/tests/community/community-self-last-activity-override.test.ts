/**
 * Repository-level coverage for `setSelfLastActivityOverride` — the
 * delete-for-me personal self-hide overlay. Part of the fix for
 * "GET /communities/mine returns stale lastActivity after a community
 * message delete": since a delete-for-me action must NEVER change what
 * other members see, it cannot go through `updateLastActivity` (which bumps
 * the shared canonical columns). Instead it reuses the SAME
 * `lastActivityUserId`/`lastActivitySelfPreview` columns already used to
 * personalize a self-referential join/role-change line, writing ONLY those
 * two columns — mirrors `setReactionActivity`'s unconditional-overwrite
 * pattern (no forward-only guard; a personal view change isn't ordered
 * against the canonical timeline).
 *
 * Exercises the REAL repository method with only the Prisma I/O boundary
 * mocked (same harness as community-reaction-repository.test.ts).
 */

jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      updateMany: jest.fn(),
    },
  },
}));

jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? key : undefined) }
    );
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        return echo();
      },
    }
  );
});

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const updateManyMock = (
  prisma as unknown as { community: { updateMany: jest.Mock } }
).community.updateMany;

const COMMUNITY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("communityRepository.setSelfLastActivityOverride", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("writes ONLY lastActivityUserId/lastActivitySelfPreview — no canonical fields", async () => {
    await communityRepository.setSelfLastActivityOverride(COMMUNITY_ID, {
      userId: USER_ID,
      preview: "an earlier message",
    });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: COMMUNITY_ID },
      data: {
        lastActivityUserId: USER_ID,
        lastActivitySelfPreview: "an earlier message",
      },
    });
  });

  it("has no forward-only (lastActivityAt lt) guard in the WHERE clause — unconditional overwrite", async () => {
    await communityRepository.setSelfLastActivityOverride(COMMUNITY_ID, {
      userId: USER_ID,
      preview: "an earlier message",
    });

    expect(updateManyMock.mock.calls[0][0].where).not.toHaveProperty(
      "lastActivityAt"
    );
  });

  it("does NOT touch lastActivityAt/Type/Preview/Username — every other member's view is unaffected", async () => {
    await communityRepository.setSelfLastActivityOverride(COMMUNITY_ID, {
      userId: USER_ID,
      preview: "an earlier message",
    });

    const data = updateManyMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("lastActivityAt");
    expect(data).not.toHaveProperty("lastActivityType");
    expect(data).not.toHaveProperty("lastActivityPreview");
    expect(data).not.toHaveProperty("lastActivityUsername");
  });
});

describe("communityRepository.updateLastActivity — unaffected by the self-hide overlay", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("a normal canonical bump (e.g. delete-for-everyone's recalculated preview) still uses the forward-only guard", async () => {
    const at = new Date("2026-07-01T10:00:00.000Z");
    await communityRepository.updateLastActivity(
      COMMUNITY_ID,
      at,
      "message",
      "the previous message",
      "Prev Sender",
      "sender-2"
    );

    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: COMMUNITY_ID,
        // Forward-only, now ordered by (lastActivityAt, lastActivitySeq) —
        // see community-last-activity-ordering.test.ts.
        OR: [
          { lastActivityAt: { lt: at } },
          {
            AND: [
              { lastActivityAt: at },
              {
                OR: [
                  { lastActivitySeq: { lte: 0 } },
                  { lastActivitySeq: null },
                ],
              },
            ],
          },
        ],
      },
      data: expect.objectContaining({
        lastActivityAt: at,
        lastActivityType: "message",
        lastActivityPreview: "the previous message",
        lastActivityUsername: "Prev Sender",
        lastActivityUserId: "sender-2",
      }),
    });
  });

  it("always overwrites lastActivityUserId/lastActivitySelfPreview — clears a stale self-hide override from an earlier delete-for-me", async () => {
    // Confirms the existing "always overwrite" behavior (already relied on by
    // join/role-change self-previews) also naturally clears a stale
    // self-hide override once anything else happens in the room.
    const at = new Date("2026-07-01T10:00:00.000Z");
    await communityRepository.updateLastActivity(
      COMMUNITY_ID,
      at,
      "message",
      "a brand new message",
      "Someone",
      "sender-9"
    );

    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({
      lastActivitySelfPreview: null,
    });
  });
});

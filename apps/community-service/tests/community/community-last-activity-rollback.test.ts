/**
 * Repository-level coverage for `rollbackLastActivity` — the BACKWARD
 * counterpart of `updateLastActivity`.
 *
 * `updateLastActivity` is forward-only (`WHERE lastActivityAt < :at`), which is
 * right for a send but structurally wrong for a delete-for-everyone /
 * auto-delete of the community's LAST message: the activity has to fall back to
 * the previous visible message, whose `createdAt` is OLDER. chat-service used to
 * satisfy the guard by sending `Date.now()`, which wrote the DELETION's
 * timestamp — so `GET /communities/mine` showed the previous message's preview
 * next to a just-now timestamp and kept the community pinned at the top of a
 * list ordered by `lastActivityAt`.
 *
 * Exercises the REAL repository method with only the Prisma I/O boundary mocked
 * (same harness as community-self-last-activity-override.test.ts).
 */

jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
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

const db = prisma as unknown as {
  community: { updateMany: jest.Mock; findUnique: jest.Mock };
};

const COMMUNITY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
/** The message that was just removed — 10:10. */
const REMOVED_AT = new Date("2026-08-10T10:10:00.000Z");
/** The previous still-visible message — 10:05. */
const PREV_AT = new Date("2026-08-10T10:05:00.000Z");

const prevActivity = {
  activityAt: PREV_AT,
  type: "message",
  preview: "Hi",
  username: "Peer One",
  userId: "peer-1",
  messageId: "msg-prev",
  clientMessageId: "cmid-2",
  seq: 7,
  contentType: "TEXT",
};

beforeEach(() => {
  db.community.updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.community.findUnique.mockReset().mockResolvedValue({
    createdAt: CREATED_AT,
  });
});

describe("communityRepository.rollbackLastActivity", () => {
  it("writes the previous message's OWN timestamp, not 'now'", async () => {
    await communityRepository.rollbackLastActivity(
      COMMUNITY_ID,
      REMOVED_AT,
      prevActivity
    );

    const call = db.community.updateMany.mock.calls[0][0];
    expect(call.data.lastActivityAt).toEqual(PREV_AT);
    expect(call.data.lastActivityPreview).toBe("Hi");
    expect(call.data.lastActivityMessageId).toBe("msg-prev");
    expect(call.data.lastActivitySeq).toBe(7);
  });

  it("guards on the REMOVED message's timestamp so a later activity is never clobbered", async () => {
    await communityRepository.rollbackLastActivity(
      COMMUNITY_ID,
      REMOVED_AT,
      prevActivity
    );

    // lte, not lt: the stored pointer may be exactly the removed message.
    expect(db.community.updateMany.mock.calls[0][0].where).toEqual({
      id: COMMUNITY_ID,
      lastActivityAt: { lte: REMOVED_AT },
    });
  });

  it("clears the personalized 'You …' overlay, which belonged to the removed message", async () => {
    await communityRepository.rollbackLastActivity(
      COMMUNITY_ID,
      REMOVED_AT,
      prevActivity
    );

    const { data } = db.community.updateMany.mock.calls[0][0];
    expect(data.lastActivitySelfPreview).toBeNull();
    expect(data.lastActivityTargetUserId).toBeNull();
    expect(data.lastActivityTargetPreview).toBeNull();
  });

  it("emptied community: falls back to the community's own createdAt + the 'created' type, never a fabricated 'now'", async () => {
    await communityRepository.rollbackLastActivity(COMMUNITY_ID, REMOVED_AT, {
      ...prevActivity,
      activityAt: null,
    });

    const { data } = db.community.updateMany.mock.calls[0][0];
    expect(data.lastActivityAt).toEqual(CREATED_AT);
    expect(data.lastActivityType).toBe("created");
    expect(data.lastActivityPreview).toBe("");
    expect(data.lastActivityUserId).toBeNull();
    expect(data.lastActivityMessageId).toBeNull();
    expect(data.lastActivitySeq).toBe(0);
  });

  it("is a no-op for a community that no longer exists", async () => {
    db.community.findUnique.mockResolvedValue(null);

    const count = await communityRepository.rollbackLastActivity(
      COMMUNITY_ID,
      REMOVED_AT,
      prevActivity
    );

    expect(count).toBe(0);
    expect(db.community.updateMany).not.toHaveBeenCalled();
  });
});

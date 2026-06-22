/**
 * Repository-level regression: `updateLastActivityUsernameByUserId` MUST re-sync
 * the denormalized community-list preview sender name on a profile rename.
 *
 * The bug it fixes: the community-list `lastActivity` preview is built from the
 * Community row's `lastActivityUsername` column, which is FROZEN at message-send
 * time. The `user.profile_updated` consumer refreshed every member's
 * `snapshotDisplayName` (so the chat room rendered the NEW name, e.g.
 * "Himanshu Vasu") but never touched `lastActivityUsername`, so the community
 * list kept showing the OLD name ("Vasu Himanshu: 📷 Photo") for the same user.
 *
 * This method closes that gap: on a rename it overwrites `lastActivityUsername`
 * with the new display name on EVERY community where the user is the current
 * last-activity sender — the sibling of `updateMemberSnapshotsByUserId`, which
 * syncs the member-list snapshot the same way.
 *
 * Exercises the REAL repository method with only the Prisma I/O boundary mocked.
 */

// Prisma I/O boundary — `community.updateMany` (rename sync) and
// `communityMember.findMany` (read-time name resolution) are touched here.
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      updateMany: jest.fn(),
    },
    communityMember: {
      findMany: jest.fn(),
    },
  },
}));

// Generated Prisma client is a heavy CJS bundle (requires runtime/library.js);
// the repo only needs the string enums, which echo their own member name.
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
const findManyMock = (
  prisma as unknown as { communityMember: { findMany: jest.Mock } }
).communityMember.findMany;

const USER = "99999999-9999-4999-8999-999999999999";
const USER_B = "88888888-8888-4888-8888-888888888888";

describe("communityRepository.updateLastActivityUsernameByUserId", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("overwrites lastActivityUsername with the new display name, scoped to rows where the user is the last-activity sender", async () => {
    await communityRepository.updateLastActivityUsernameByUserId(
      USER,
      "Himanshu Vasu"
    );

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { lastActivityUserId: USER },
      data: { lastActivityUsername: "Himanshu Vasu" },
    });
  });

  it("does NOT touch rows where another user is the last-activity sender (no global where)", async () => {
    await communityRepository.updateLastActivityUsernameByUserId(
      USER,
      "Himanshu Vasu"
    );

    const arg = updateManyMock.mock.calls[0][0];
    // The scoping predicate is the whole point — a missing/empty where would
    // stamp the rename onto every community's list preview.
    expect(arg.where).toEqual({ lastActivityUserId: USER });
    expect(arg.where.lastActivityUserId).toBe(USER);
  });
});

describe("communityRepository.getDisplayNamesByUserIds (read-time name resolution)", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("returns userId → live snapshotDisplayName for the requested users", async () => {
    findManyMock.mockResolvedValue([
      { userId: USER, snapshotDisplayName: "Himanshu Vasu" },
      { userId: USER_B, snapshotDisplayName: "Some One" },
    ]);

    const map = await communityRepository.getDisplayNamesByUserIds([
      USER,
      USER_B,
    ]);

    expect(map.get(USER)).toBe("Himanshu Vasu");
    expect(map.get(USER_B)).toBe("Some One");
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: { in: [USER, USER_B] } },
      select: { userId: true, snapshotDisplayName: true },
    });
  });

  it("dedupes by userId (a user can be a member of many communities), keeping the first non-empty name", async () => {
    findManyMock.mockResolvedValue([
      { userId: USER, snapshotDisplayName: "Himanshu Vasu" },
      { userId: USER, snapshotDisplayName: "Himanshu Vasu" },
    ]);

    const map = await communityRepository.getDisplayNamesByUserIds([
      USER,
      USER,
    ]);

    expect(map.size).toBe(1);
    expect(map.get(USER)).toBe("Himanshu Vasu");
    // Deduped at the query layer too — the `in` clause is a unique set.
    expect(findManyMock.mock.calls[0][0].where.userId.in).toEqual([USER]);
  });

  it("skips empty/blank snapshot names so the caller falls back to the stored value", async () => {
    findManyMock.mockResolvedValue([{ userId: USER, snapshotDisplayName: "" }]);

    const map = await communityRepository.getDisplayNamesByUserIds([USER]);

    expect(map.has(USER)).toBe(false);
  });

  it("short-circuits with no DB call when there are no sender ids", async () => {
    const map = await communityRepository.getDisplayNamesByUserIds([]);

    expect(map.size).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("communityRepository.updateLastActivity (self-preview column)", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("persists lastActivitySelfPreview for a self-referential SYSTEM bump", async () => {
    const at = new Date("2026-06-19T12:00:00.000Z");
    await communityRepository.updateLastActivity(
      "comm-1",
      at,
      "system",
      "Jim is now a moderator",
      null,
      USER,
      "You are now a moderator"
    );

    const arg = updateManyMock.mock.calls[0][0];
    expect(arg.data.lastActivityPreview).toBe("Jim is now a moderator");
    expect(arg.data.lastActivitySelfPreview).toBe("You are now a moderator");
    expect(arg.data.lastActivityUserId).toBe(USER);
    // forward-only guard preserved.
    expect(arg.where).toEqual({ id: "comm-1", lastActivityAt: { lt: at } });
  });

  it("CLEARS lastActivitySelfPreview on a non-self bump (default null) so a stale 'You …' can't linger", async () => {
    const at = new Date("2026-06-19T13:00:00.000Z");
    // A subsequent normal message omits the selfPreview arg entirely.
    await communityRepository.updateLastActivity(
      "comm-1",
      at,
      "message",
      "📷 Photo",
      "Alice",
      USER
    );

    expect(
      updateManyMock.mock.calls[0][0].data.lastActivitySelfPreview
    ).toBeNull();
  });
});

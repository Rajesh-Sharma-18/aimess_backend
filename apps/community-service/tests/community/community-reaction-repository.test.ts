/**
 * Repository-level coverage for the reaction OVERLAY write paths:
 * `setReactionActivity` (unconditional overwrite on add) and
 * `clearReactionActivityIfCurrent` (identity-matched clear on remove).
 *
 * Exercises the REAL repository methods with only the Prisma I/O boundary
 * mocked. `tests/setup/global-mocks.ts` auto-mocks the ENTIRE
 * community.repository module for every test (a hand-written stub object
 * that doesn't know about these methods) — `jest.unmock` opts this file back
 * into the real module so the mocked Prisma boundary below is what actually
 * gets exercised.
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
const MESSAGE_ID = "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const REACTED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("communityRepository.setReactionActivity", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("unconditionally overwrites the overlay columns (no forward-only guard)", async () => {
    await communityRepository.setReactionActivity(COMMUNITY_ID, {
      messageId: MESSAGE_ID,
      emoji: "👍",
      actorId: ACTOR,
      actorPreview: 'You reacted 👍 to "Hello"',
      targetId: TARGET,
      targetPreview: 'Peter reacted 👍 to "Hello"',
      reactedAt: REACTED_AT,
    });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: COMMUNITY_ID },
      data: {
        lastActivityReactionAt: REACTED_AT,
        lastActivityReactionMessageId: MESSAGE_ID,
        lastActivityReactionEmoji: "👍",
        lastActivityReactionActorId: ACTOR,
        lastActivityReactionActorPreview: 'You reacted 👍 to "Hello"',
        lastActivityReactionTargetId: TARGET,
        lastActivityReactionTargetPreview: 'Peter reacted 👍 to "Hello"',
      },
    });
    // No lastActivityAt/lt guard in the WHERE — canonical columns untouched.
    expect(updateManyMock.mock.calls[0][0].where).not.toHaveProperty(
      "lastActivityAt"
    );
  });

  it("self-reaction: caller passes targetId/targetPreview null — no second viewer stored", async () => {
    await communityRepository.setReactionActivity(COMMUNITY_ID, {
      messageId: MESSAGE_ID,
      emoji: "👍",
      actorId: ACTOR,
      actorPreview: 'You reacted 👍 to "Hello"',
      targetId: null,
      targetPreview: null,
      reactedAt: REACTED_AT,
    });

    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({
      lastActivityReactionTargetId: null,
      lastActivityReactionTargetPreview: null,
    });
  });
});

describe("communityRepository.clearReactionActivityIfCurrent", () => {
  beforeEach(() => {
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  it("clears all overlay columns, scoped by an exact (messageId, emoji, actorId) match", async () => {
    await communityRepository.clearReactionActivityIfCurrent(COMMUNITY_ID, {
      messageId: MESSAGE_ID,
      emoji: "👍",
      actorId: ACTOR,
    });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: COMMUNITY_ID,
        lastActivityReactionMessageId: MESSAGE_ID,
        lastActivityReactionEmoji: "👍",
        lastActivityReactionActorId: ACTOR,
      },
      data: {
        lastActivityReactionAt: null,
        lastActivityReactionMessageId: null,
        lastActivityReactionEmoji: null,
        lastActivityReactionActorId: null,
        lastActivityReactionActorPreview: null,
        lastActivityReactionTargetId: null,
        lastActivityReactionTargetPreview: null,
      },
    });
  });

  it("removing a DIFFERENT (non-displayed) reaction matches zero rows — a safe no-op", async () => {
    // Simulates Mongo matching nothing: the WHERE's identity triple doesn't
    // equal what's currently stored, so updateMany naturally affects 0 rows.
    updateManyMock.mockResolvedValue({ count: 0 });

    await communityRepository.clearReactionActivityIfCurrent(COMMUNITY_ID, {
      messageId: MESSAGE_ID,
      emoji: "🔥", // a different emoji than what's actually displayed
      actorId: ACTOR,
    });

    // The call still issues the scoped updateMany — it's the WHERE clause
    // (not application code) that guarantees the no-op.
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lastActivityReactionEmoji: "🔥" }),
      })
    );
  });
});

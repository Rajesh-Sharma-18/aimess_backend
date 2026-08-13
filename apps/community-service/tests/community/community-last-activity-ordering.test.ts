/**
 * Issue #74 (community surface) — "last activity not updating for fast typing".
 *
 * The community bump is NOT a direct call: chat-service publishes
 * `community.activity` to RabbitMQ and this service's consumer runs it with
 * `prefetch: 10` inside a non-awaited IIFE. A burst of rapid sends is therefore
 * processed CONCURRENTLY and in an arbitrary order. `lastActivityAt` is only
 * millisecond-resolution, so the old `WHERE lastActivityAt < :at` guard ordered
 * most of the burst correctly but had nothing to say about two messages sharing
 * one millisecond — whichever handler happened to run last won, and the row
 * could be left previewing message #4 of a five-message burst.
 *
 * `lastActivitySeq` (the per-room `sequenceNumber`, already stored for exactly
 * this reason) now breaks that tie. Same harness as
 * community-last-activity-rollback.test.ts: the real repository method with
 * only the Prisma I/O boundary mocked.
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
const AT = new Date("2026-08-13T10:00:00.000Z");

beforeEach(() => {
  db.community.updateMany.mockReset().mockResolvedValue({ count: 1 });
});

async function bump(seq: number) {
  await communityRepository.updateLastActivity(
    COMMUNITY_ID,
    AT,
    "message",
    `msg ${seq}`,
    "Sender",
    "sender-1",
    null,
    null,
    null,
    { messageId: `m-${seq}`, clientMessageId: null, seq, contentType: "TEXT" }
  );
  return db.community.updateMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

describe("communityRepository.updateLastActivity — forward-only ordering", () => {
  it("keeps the strictly-newer-timestamp branch", async () => {
    const { where } = await bump(5);
    expect((where.OR as Record<string, unknown>[])[0]).toEqual({
      lastActivityAt: { lt: AT },
    });
  });

  it("adds a same-millisecond tie-break on lastActivitySeq", async () => {
    const { where } = await bump(5);
    expect((where.OR as Record<string, unknown>[])[1]).toEqual({
      AND: [
        { lastActivityAt: AT },
        // `lte`, not `lt`: an in-place refresh of the very message already
        // stored must still land. Two different messages never share a seq.
        {
          OR: [{ lastActivitySeq: { lte: 5 } }, { lastActivitySeq: null }],
        },
      ],
    });
  });

  it("carries the null branch for rows written before lastActivitySeq existed", async () => {
    // A MongoDB range filter never matches a MISSING field, so without this
    // alternative a legacy community could never break a tie at all.
    const { where } = await bump(1);
    const tie = (where.OR as { AND: Record<string, unknown>[] }[])[1]!
      .AND[1] as {
      OR: Record<string, unknown>[];
    };
    expect(tie.OR[1]).toEqual({ lastActivitySeq: null });
  });

  it("writes the same seq it guarded on, so the next tie compares against it", async () => {
    const { where, data } = await bump(7);
    const guarded = (
      where.OR as { AND: { OR: { lastActivitySeq: { lte: number } }[] }[] }[]
    )[1]!.AND[1]!.OR[0]!.lastActivitySeq.lte;
    expect(guarded).toBe(7);
    expect(data.lastActivitySeq).toBe(7);
  });

  it("defaults a missing seq to 0 on both the guard and the write", async () => {
    await communityRepository.updateLastActivity(
      COMMUNITY_ID,
      AT,
      "join",
      "Someone joined",
      "Sender",
      "sender-1"
    );
    const call = db.community.updateMany.mock.calls[0][0];
    expect(call.data.lastActivitySeq).toBe(0);
    expect(call.where.OR[1].AND[1].OR[0].lastActivitySeq.lte).toBe(0);
  });
});

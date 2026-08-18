/**
 * The Call History query shape.
 *
 * This asserts the WHERE clause rather than results on purpose: the bug it
 * guards against is a MongoDB filter that is silently valid and matches
 * nothing, which no in-memory stub of the repository can reproduce. On live
 * data `answeredAt: null` matched 0 rows where `isSet: false` matched 38,
 * because an unanswered call never writes the field at all and Prisma's Mongo
 * connector treats absent and JSON-null as different — while the read path
 * hydrates a missing field as `null`, hiding the difference.
 */
import { CallRepository } from "../../src/repositories/call.repository.js";

type Where = Record<string, unknown>;

function repoWithSpy() {
  const findMany = jest.fn().mockResolvedValue([]);
  const repo = new CallRepository({ call: { findMany } } as never);
  return { repo, findMany };
}

const whereOf = (findMany: jest.Mock): Where =>
  (findMany.mock.calls[0]![0] as { where: Where }).where;

describe("CallRepository.findHistoryPage", () => {
  it("matches an unanswered call whether the field is null OR absent", async () => {
    const { repo, findMany } = repoWithSpy();
    await repo.findHistoryPage({ userId: "me", filter: "missed", take: 10 });

    const where = whereOf(findMany);
    expect(where.AND).toEqual([
      { OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] },
    ]);
    // The unanswered clause must NOT be a bare `answeredAt: null`.
    expect(where.answeredAt).toBeUndefined();
  });

  it("scopes missed to calls that rang ME", async () => {
    const { repo, findMany } = repoWithSpy();
    await repo.findHistoryPage({ userId: "me", filter: "missed", take: 10 });

    const where = whereOf(findMany);
    expect(where.calleeId).toBe("me");
    expect(where.callerId).toBeUndefined();
  });

  it("does not constrain answeredAt on the other tabs", async () => {
    for (const filter of ["all", "incoming", "outgoing"] as const) {
      const { repo, findMany } = repoWithSpy();
      await repo.findHistoryPage({ userId: "me", filter, take: 10 });
      const where = whereOf(findMany);
      expect(where.AND).toBeUndefined();
      expect(where.answeredAt).toBeUndefined();
    }
  });

  it("keeps the participant OR intact on the all tab", async () => {
    const { repo, findMany } = repoWithSpy();
    await repo.findHistoryPage({ userId: "me", filter: "all", take: 10 });

    // An `AND`-wrapped outcome clause exists so this OR can never be clobbered
    // by a second top-level OR.
    expect(whereOf(findMany).OR).toEqual([
      { callerId: "me" },
      { calleeId: "me" },
    ]);
  });

  it("excludes group calls and live rows from every tab", async () => {
    for (const filter of ["all", "incoming", "outgoing", "missed"] as const) {
      const { repo, findMany } = repoWithSpy();
      await repo.findHistoryPage({ userId: "me", filter, take: 10 });
      const where = whereOf(findMany);
      expect(where.groupId).toBeNull();
      expect(where.status).toEqual({
        in: ["ENDED", "MISSED", "DECLINED", "FAILED"],
      });
    }
  });

  it("applies the cursor as an exclusive upper bound, newest first", async () => {
    const { repo, findMany } = repoWithSpy();
    const before = new Date("2026-08-18T06:00:00.000Z");
    await repo.findHistoryPage({
      userId: "me",
      filter: "all",
      before,
      take: 10,
    });

    const args = findMany.mock.calls[0]![0] as {
      where: Where;
      orderBy: unknown;
      take: number;
    };
    expect(args.where.initiatedAt).toEqual({ lt: before });
    expect(args.orderBy).toEqual({ initiatedAt: "desc" });
    expect(args.take).toBe(10);
  });
});

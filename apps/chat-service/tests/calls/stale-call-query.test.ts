/**
 * `findStuckInProgress` — the predicate that decides which stranded calls can
 * ever be cleaned up.
 *
 * The bug this pins was a docstring that described behaviour the query did not
 * have. It claimed to return "IN_PROGRESS rows past the ceiling, plus rows with
 * a null `answeredAt`", but the filter was a bare `answeredAt: { lt: cutoff }`.
 * MongoDB's `lt` is type-bracketed, so a Date comparison never reaches a row
 * whose field is null or absent. Verified against the dev database: of 413 call
 * documents with no `answeredAt`, exactly zero matched `{ lt: now }`.
 *
 * That mattered because `activeWhere` ALSO excludes such a row, on the stated
 * understanding that this method reaps it. Neither did. The row was invisible to
 * every busy gate and unreachable by every sweep — immortal, and rendered to its
 * participants as permanently "in progress".
 *
 * Asserted at the repository, because this is one of those guards that lives
 * entirely in the query: the service stubs `findStuckInProgress` out, so no
 * service-level test can see the predicate at all. Same shape as the
 * `claimForMissed` where-clause test in call-no-answer.test.ts.
 */
import { CallRepository } from "../../src/repositories/call.repository.js";
import { CallStatus } from "../../src/types/enums.js";

const CUTOFF = new Date(1_700_000_000_000);

function buildRepo() {
  const findMany = jest.fn().mockResolvedValue([]);
  const repo = new CallRepository({ call: { findMany } } as never);
  return { repo, findMany };
}

/** The `where` argument the repository actually handed Prisma. */
async function whereFor(limit = 50) {
  const { repo, findMany } = buildRepo();
  await repo.findStuckInProgress(CUTOFF, limit);
  return (findMany.mock.calls[0]![0] as { where: Record<string, unknown> })
    .where;
}

describe("CallRepository.findStuckInProgress", () => {
  it("scopes to IN_PROGRESS and reaps all three stranded shapes", async () => {
    expect(await whereFor()).toEqual({
      status: CallStatus.IN_PROGRESS,
      OR: [
        { answeredAt: { lt: CUTOFF } },
        { answeredAt: null, initiatedAt: { lt: CUTOFF } },
        { answeredAt: { isSet: false }, initiatedAt: { lt: CUTOFF } },
      ],
    });
  });

  it("covers a row whose answeredAt is ABSENT, not merely null", async () => {
    const or = (await whereFor()).OR as Record<string, unknown>[];

    // `create` omits `answeredAt` entirely, so every call document carries the
    // field absent rather than null until something stamps it — which is the
    // shape all 413 rows on the dev database actually have. Prisma's `null`
    // equality is documented in this repo as NOT reaching an absent field (see
    // PENDING_LOGIN in notification.repository.ts), so dropping the `isSet`
    // branch would leave the real-world case unswept while the test using an
    // explicit null still passed.
    expect(or).toContainEqual({
      answeredAt: { isSet: false },
      initiatedAt: { lt: CUTOFF },
    });
  });

  it("bounds every never-answered branch by initiatedAt", async () => {
    const or = (await whereFor()).OR as Record<string, unknown>[];

    // Without this bound the sweep would reap a call in the same instant it was
    // answered: a row that has no `answeredAt` has no other clock on it, so an
    // unbounded null branch matches every live call immediately.
    for (const branch of or) {
      if ("initiatedAt" in branch) continue;
      expect(branch).toEqual({ answeredAt: { lt: CUTOFF } });
    }
    expect(or.filter((b) => "initiatedAt" in b)).toHaveLength(2);
  });

  it("passes the batch limit through as take", async () => {
    const { repo, findMany } = buildRepo();

    await repo.findStuckInProgress(CUTOFF, 7);

    expect((findMany.mock.calls[0]![0] as { take: number }).take).toBe(7);
  });
});

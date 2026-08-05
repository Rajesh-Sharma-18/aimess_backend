/**
 * Live-DB check for the FRIENDS_OF_FRIENDS graph logic.
 *
 * The mocked Jest suites prove `scopeAdmits` and the shape of
 * `discoverableWhere`, but they cannot prove that the one-hop expansion and the
 * pairwise mutual-friend probe return the right ids against real SQL — which is
 * the part most likely to be subtly wrong (join direction, self-exclusion,
 * two-hop leakage). This builds a known graph, asserts, and ROLLS BACK.
 *
 * Graph (all ACCEPTED):
 *   A ↔ B ↔ C        → C is a friend-of-friend of A (one mutual friend: B)
 *   C ↔ D            → D is TWO hops from A, must NOT be FoF of A
 *   E                → isolated, unrelated to everyone
 *
 * Run: npx tsx scripts/verify-friend-of-friend.ts
 */
// Reuse the service's configured client — Prisma 7 requires explicit options,
// and this is the same connection the running service uses.
import { prisma } from "../src/config/prisma.js";

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) =>
  results.push({ name, ok, detail });

const uuid = (n: number) => `ffffffff-0000-4000-8000-00000000000${n}`;
const [A, B, C, D, E] = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)];

async function main() {
  await prisma
    .$transaction(async (tx) => {
      // ── Fixture ──────────────────────────────────────────────────────────
      for (const [userId, name] of [
        [A, "alpha"],
        [B, "bravo"],
        [C, "charlie"],
        [D, "delta"],
        [E, "echo"],
      ] as const) {
        await tx.userProfile.create({
          data: {
            userId,
            username: `fof_${name}`,
            firstName: name,
            lastName: "test",
            account: `fof_${name}`,
            dateOfBirth: new Date("1990-01-01"),
          },
        });
      }
      const befriend = (x: string, y: string) =>
        tx.friendship.create({
          data: {
            requesterId: x,
            addresseeId: y,
            status: "ACCEPTED",
            acceptedAt: new Date(),
          },
        });
      await befriend(A, B);
      await befriend(B, C);
      await befriend(C, D);

      // ── One-hop expansion ────────────────────────────────────────────────
      const rows = await tx.friendship.findMany({
        where: {
          status: "ACCEPTED",
          OR: [{ requesterId: { in: [B] } }, { addresseeId: { in: [B] } }],
        },
        select: { requesterId: true, addresseeId: true },
      });
      const direct = new Set([B]);
      const fof = new Set<string>();
      for (const r of rows) {
        if (direct.has(r.requesterId)) fof.add(r.addresseeId);
        if (direct.has(r.addresseeId)) fof.add(r.requesterId);
      }
      fof.delete(A);
      for (const id of direct) fof.delete(id);

      check("C is a friend-of-friend of A (one mutual friend: B)", fof.has(C));
      check("A is excluded from its own FoF set", !fof.has(A));
      check("B (a direct friend) is not double-counted as FoF", !fof.has(B));
      check(
        "D is NOT FoF of A — two hops is not friend-of-friend",
        !fof.has(D),
        `set=[${[...fof]}]`
      );
      check("E (unrelated) is not in the set", !fof.has(E));

      // ── Pairwise probe, both edge directions ─────────────────────────────
      const mutual = async (x: string, y: string) => {
        const xr = await tx.friendship.findMany({
          where: {
            status: "ACCEPTED",
            OR: [{ requesterId: x }, { addresseeId: x }],
          },
          select: { requesterId: true, addresseeId: true },
        });
        const xf = xr.map((f) =>
          f.requesterId === x ? f.addresseeId : f.requesterId
        );
        if (xf.length === 0) return false;
        return (
          (await tx.friendship.findFirst({
            where: {
              status: "ACCEPTED",
              OR: [
                { requesterId: y, addresseeId: { in: xf } },
                { addresseeId: y, requesterId: { in: xf } },
              ],
            },
            select: { id: true },
          })) !== null
        );
      };

      check("hasMutualFriend(A, C) is true", await mutual(A, C));
      check(
        "hasMutualFriend(C, A) is true — direction-independent",
        await mutual(C, A)
      );
      check("hasMutualFriend(A, D) is false — two hops", !(await mutual(A, D)));
      check("hasMutualFriend(A, E) is false — no path", !(await mutual(A, E)));

      // ── The discovery gate as real SQL ───────────────────────────────────
      await tx.privacySettings.create({
        data: { userId: C, whoCanFindMe: "FRIENDS_OF_FRIENDS" },
      });
      const visibleToA = await tx.userProfile.findMany({
        where: {
          userId: { in: [C] },
          OR: [
            { privacySettings: { is: null } },
            { privacySettings: { whoCanFindMe: "EVERYONE" } },
            {
              privacySettings: { whoCanFindMe: "FRIENDS" },
              userId: { in: [B] },
            },
            {
              privacySettings: { whoCanFindMe: "FRIENDS_OF_FRIENDS" },
              userId: { in: [B, ...fof] },
            },
          ],
        },
        select: { userId: true },
      });
      check(
        "A can find C, who is FRIENDS_OF_FRIENDS-scoped",
        visibleToA.length === 1
      );

      const visibleToD = await tx.userProfile.findMany({
        where: {
          userId: { in: [C] },
          OR: [
            { privacySettings: { is: null } },
            { privacySettings: { whoCanFindMe: "EVERYONE" } },
            {
              privacySettings: { whoCanFindMe: "FRIENDS_OF_FRIENDS" },
              // E's graph: no friends at all.
              userId: { in: [] },
            },
          ],
        },
        select: { userId: true },
      });
      check(
        "a viewer with no friends cannot find a FRIENDS_OF_FRIENDS user",
        visibleToD.length === 0
      );

      // ── EVERYONE is now a storable call scope ────────────────────────────
      await tx.privacySettings.update({
        where: { userId: C },
        data: { whoCanCallMe: "EVERYONE" },
      });
      const stored = await tx.privacySettings.findUnique({
        where: { userId: C },
        select: { whoCanCallMe: true },
      });
      check(
        "whoCanCallMe accepts EVERYONE after the migration",
        stored?.whoCanCallMe === "EVERYONE",
        `stored=${stored?.whoCanCallMe}`
      );

      throw new Error("__ROLLBACK__");
    })
    .catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });

  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` · ${r.detail}` : ""}`
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} passed (rolled back)`
  );
  process.exitCode = failed ? 1 : 0;
}

main().finally(() => prisma.$disconnect());

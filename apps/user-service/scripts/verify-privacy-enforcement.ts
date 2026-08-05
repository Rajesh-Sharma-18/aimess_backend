/**
 * Live verification of the whoCanFindMe discovery gate against the real
 * Postgres schema — the one thing the Jest suites cannot prove, because they
 * mock the repository and never execute `discoverableWhere` as SQL.
 *
 * Everything runs inside an interactive transaction that is deliberately rolled
 * back, so no row created here ever persists. Run with:
 *   npx tsx scripts/verify-privacy-enforcement.ts
 */
import { prisma } from "../src/config/prisma.js";
import { discoverableWhere } from "../src/lib/privacy-scope.js";

/** Sentinel thrown to force the verification transaction to roll back. */
const ROLLBACK = Symbol("rollback");

const ids = {
  viewer: "00000000-0000-4000-8000-0000000000a1",
  everyone: "00000000-0000-4000-8000-0000000000e1",
  friendsScoped: "00000000-0000-4000-8000-0000000000f1",
  noOne: "00000000-0000-4000-8000-0000000000b1",
  unset: "00000000-0000-4000-8000-0000000000c1",
};

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const base = (userId: string, username: string) => ({
        userId,
        username,
        normalizedUsername: username,
        firstName: "Privacy",
        lastName: "Probe",
        normalizedFirstName: "privacy",
        normalizedLastName: "probe",
        normalizedFullName: "privacyprobe",
        dateOfBirth: new Date("1990-01-01"),
      });

      await tx.userProfile.createMany({
        data: [
          base(ids.viewer, "zzprobe_viewer"),
          base(ids.everyone, "zzprobe_everyone"),
          base(ids.friendsScoped, "zzprobe_friends"),
          base(ids.noOne, "zzprobe_noone"),
          base(ids.unset, "zzprobe_unset"),
        ],
      });

      // `unset` deliberately gets NO privacySettings row — it must still be
      // discoverable (schema default is EVERYONE).
      await tx.privacySettings.createMany({
        data: [
          { userId: ids.everyone, whoCanFindMe: "EVERYONE" },
          { userId: ids.friendsScoped, whoCanFindMe: "FRIENDS" },
          { userId: ids.noOne, whoCanFindMe: "NO_ONE" },
        ],
      });

      const probeIds = [ids.everyone, ids.friendsScoped, ids.noOne, ids.unset];
      const search = async (viewerFriendIds: string[]) =>
        (
          await tx.userProfile.findMany({
            where: {
              userId: { in: probeIds },
              deletedAt: null,
              ...discoverableWhere(viewerFriendIds),
            },
            select: { userId: true },
          })
        ).map((r) => r.userId);

      // --- Viewer is a STRANGER to everyone -----------------------------
      const asStranger = await search([]);
      check(
        "EVERYONE is discoverable by a stranger",
        asStranger.includes(ids.everyone)
      );
      check(
        "no-settings-row user is discoverable (defaults to EVERYONE)",
        asStranger.includes(ids.unset)
      );
      check(
        "FRIENDS-scoped user is HIDDEN from a stranger",
        !asStranger.includes(ids.friendsScoped)
      );
      check(
        "NO_ONE user is HIDDEN from a stranger",
        !asStranger.includes(ids.noOne)
      );

      // --- Viewer is a FRIEND of the friends-scoped + no_one users ------
      const asFriend = await search([ids.friendsScoped, ids.noOne]);
      check(
        "FRIENDS-scoped user IS discoverable by a friend",
        asFriend.includes(ids.friendsScoped)
      );
      check(
        "NO_ONE user stays hidden EVEN from a friend",
        !asFriend.includes(ids.noOne),
        `returned: ${JSON.stringify(asFriend)}`
      );

      // --- The gate must not swallow the text filter --------------------
      const withText = await tx.userProfile.findMany({
        where: {
          userId: { in: probeIds },
          deletedAt: null,
          AND: [{ normalizedUsername: { contains: "everyone" } }],
          ...discoverableWhere([]),
        },
        select: { userId: true },
      });
      check(
        "discovery gate composes with a text filter (AND not clobbered)",
        withText.length === 1 && withText[0]?.userId === ids.everyone,
        `returned ${withText.length} row(s)`
      );

      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  // Prove the rollback actually happened — nothing may survive.
  const leaked = await prisma.userProfile.count({
    where: { username: { startsWith: "zzprobe_" } },
  });
  check(
    "transaction rolled back — zero probe rows persisted",
    leaked === 0,
    `${leaked} leaked`
  );

  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

/**
 * AIMESS-273 one-off: trims stacked combining marks (Zalgo) in existing first/last names down to 3 per letter.
 * Dry run by default; pass --apply to write. Idempotent.
 *
 * Usage: pnpm --filter @aimess/user-service db:cleanup:stacked-name-marks [--apply]
 */
import { capCombiningMarks, hasExcessCombiningMarks } from "@aimess/constants";
import { prisma } from "../src/config/prisma.js";
import {
  normalizeForSearch,
  buildNormalizedFullName,
} from "../src/lib/user-search.util.js";

const apply = process.argv.includes("--apply");

async function cleanupStackedNameMarks() {
  const profiles = await prisma.userProfile.findMany({
    select: { userId: true, username: true, firstName: true, lastName: true },
  });
  const broken = profiles.filter(
    (p) => hasExcessCombiningMarks(p.firstName) || hasExcessCombiningMarks(p.lastName)
  );
  console.log(`Scanned ${profiles.length} profiles; ${broken.length} have stacked marks.`);

  for (const p of broken) {
    const firstName = capCombiningMarks(p.firstName).trim();
    const lastName = capCombiningMarks(p.lastName).trim();
    console.log(
      `${p.userId} @${p.username}: ${JSON.stringify(p.firstName)} ${JSON.stringify(p.lastName)} -> ${JSON.stringify(firstName)} ${JSON.stringify(lastName)}`
    );
    if (!apply) continue;
    await prisma.userProfile.update({
      where: { userId: p.userId },
      data: {
        firstName,
        lastName,
        normalizedFirstName: normalizeForSearch(firstName),
        normalizedLastName: normalizeForSearch(lastName),
        normalizedFullName: buildNormalizedFullName(firstName, lastName),
      },
    });
  }
  console.log(apply ? `Updated ${broken.length} profiles.` : "Dry run — nothing written. Re-run with --apply.");
}

cleanupStackedNameMarks()
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

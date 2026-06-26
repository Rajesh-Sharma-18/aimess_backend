import type { Community } from "../src/generated/prisma/index.js";
import { prisma } from "../src/config/prisma.js";

interface CommunityComparison {
  field: string;
  newValue: unknown;
  oldValue: unknown;
  different: boolean;
}

async function analyzeAndFixCommunities() {
  console.log("🔍 Starting community search issue diagnosis and fix...\n");

  try {
    // Step 1: Find the newest community (likely created recently and working)
    const newestCommunity = await prisma.community.findFirst({
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    if (!newestCommunity) {
      console.error("❌ No communities found in database");
      return;
    }

    console.log(`✅ Reference (newest) community found:`);
    console.log(`   ID: ${newestCommunity.id}`);
    console.log(`   Name: ${newestCommunity.name}`);
    console.log(`   Created: ${newestCommunity.createdAt}\n`);

    // Step 2: Get all other communities
    const allCommunities = await prisma.community.findMany({
      where: { id: { not: newestCommunity.id } },
      orderBy: { createdAt: "desc" },
    });

    console.log(
      `📊 Found ${allCommunities.length} other communities to check\n`
    );

    // Step 3: Compare schema
    const fieldsToCheck = [
      "status",
      "moderationStatus",
      "type",
      "deletedAt",
      "lastActivityAt",
      "lastActivityType",
      "lastActivityPreview",
      "lastActivityUsername",
      "lastActivityUserId",
      "lastActivitySelfPreview",
    ];

    const differences: Map<string, CommunityComparison[]> = new Map();

    for (const oldCommunity of allCommunities) {
      const diffs: CommunityComparison[] = [];

      for (const field of fieldsToCheck) {
        const newValue = (newestCommunity as Record<string, unknown>)[field];
        const oldValue = (oldCommunity as Record<string, unknown>)[field];

        if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
          diffs.push({
            field,
            newValue,
            oldValue,
            different: true,
          });
        }
      }

      if (diffs.length > 0) {
        differences.set(oldCommunity.id, diffs);
      }
    }

    // Step 4: Identify which fields need fixing
    const fieldsNeedingFix = new Set<string>();
    for (const diffs of differences.values()) {
      for (const diff of diffs) {
        fieldsNeedingFix.add(diff.field);
      }
    }

    console.log(`🔧 Fields that differ between old and new communities:`);
    for (const field of fieldsNeedingFix) {
      console.log(`   - ${field}`);
    }
    console.log("");

    // Step 5: Show sample differences
    if (differences.size > 0) {
      const firstDiff = Array.from(differences.entries())[0];
      console.log(
        `📋 Sample differences for community ${firstDiff[0].substring(0, 8)}...:`
      );
      for (const diff of firstDiff[1]) {
        console.log(`   ${diff.field}:`);
        console.log(`     Old: ${JSON.stringify(diff.oldValue)}`);
        console.log(`     New: ${JSON.stringify(diff.newValue)}`);
      }
      console.log("");
    }

    // Step 6: Fix critical fields that affect searching
    console.log(`🛠️  Fixing communities...\n`);

    let fixedCount = 0;
    const updatePromises: Promise<Community>[] = [];

    for (const oldCommunity of allCommunities) {
      const updateData: Record<string, string | null | Date> = {};
      let needsUpdate = false;

      // Fix status field if missing or wrong
      if (
        !oldCommunity.status ||
        oldCommunity.status === null ||
        oldCommunity.status === undefined
      ) {
        updateData.status = newestCommunity.status || "ACTIVE";
        needsUpdate = true;
      }

      // Fix moderationStatus if missing
      if (
        !oldCommunity.moderationStatus ||
        oldCommunity.moderationStatus === null
      ) {
        updateData.moderationStatus =
          newestCommunity.moderationStatus || "ACTIVE";
        needsUpdate = true;
      }

      // Ensure type is set
      if (!oldCommunity.type) {
        updateData.type = newestCommunity.type || "PUBLIC";
        needsUpdate = true;
      }

      // Ensure deletedAt is properly set (should be unset/null)
      if (oldCommunity.deletedAt && newestCommunity.deletedAt === null) {
        updateData.deletedAt = null;
        needsUpdate = true;
      }

      if (needsUpdate) {
        updatePromises.push(
          prisma.community.update({
            where: { id: oldCommunity.id },
            data: updateData,
          })
        );
        fixedCount++;
      }
    }

    // Execute all updates in parallel
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
      console.log(`✅ Fixed ${fixedCount} communities\n`);
    } else {
      console.log(`✅ All communities already have correct schema\n`);
    }

    // Step 7: Verify fixes
    console.log(`🔐 Verifying fixes...\n`);

    const brokenCommunities = await prisma.community.findMany({
      where: {
        AND: [{ deletedAt: { isSet: false } }, { status: { not: "CLOSED" } }],
      },
    });

    console.log(
      `✅ Communities matching search criteria (not deleted, not closed): ${brokenCommunities.length}`
    );

    // Step 8: Check member relationships
    console.log(`\n📋 Checking community member relationships...\n`);

    const communitiesWithoutMembers = await prisma.community.findMany({
      where: {
        deletedAt: { isSet: false },
        status: { not: "CLOSED" },
      },
      include: {
        _count: {
          select: {
            members: {
              where: { status: "ACTIVE" },
            },
          },
        },
      },
    });

    let orphanCount = 0;
    for (const community of communitiesWithoutMembers) {
      if (community._count.members === 0) {
        orphanCount++;
        console.log(`⚠️  Community "${community.name}" has no ACTIVE members`);
      }
    }

    if (orphanCount === 0) {
      console.log(`✅ All communities have at least one ACTIVE member\n`);
    }

    console.log(`\n🎉 Fix complete! Your search issue should be resolved.`);
    console.log(`\nNext steps:`);
    console.log(`  1. Test searching for old communities`);
    console.log(`  2. Verify they now appear in results`);
    console.log(`  3. Check that pagination still works`);
  } catch (error) {
    console.error("❌ Error during fix:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeAndFixCommunities();

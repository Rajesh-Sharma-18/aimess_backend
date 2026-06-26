import { prisma } from "../src/config/prisma.js";

async function fixCommunitySearch() {
  console.log("🔍 Diagnosing community search issue...\n");

  try {
    // Step 1: Verify the exact search query returns nothing for old communities
    const totalCommunities = await prisma.community.count({
      where: { deletedAt: { isSet: false }, status: { not: "CLOSED" } },
    });
    console.log(
      `📊 Total non-deleted/non-closed communities: ${totalCommunities}`
    );

    const searchResults = await prisma.community.findMany({
      where: {
        deletedAt: { isSet: false },
        status: { not: "CLOSED" },
      },
      select: {
        id: true,
        name: true,
        categoryId: true,
        category: { select: { id: true, name: true } },
      },
    });

    console.log(
      `📊 Communities returned WITH category select: ${searchResults.length}`
    );

    const missingCategory = searchResults.filter((c) => !c.category);

    console.log(
      `⚠️  Communities with null/missing category relation: ${missingCategory.length}`
    );

    if (missingCategory.length > 0) {
      console.log(
        "\n🚨 ROOT CAUSE CONFIRMED: category join is filtering out communities"
      );
      console.log("   These communities are missing a valid categoryId:\n");
      for (const c of missingCategory.slice(0, 5)) {
        console.log(
          `   - "${c.name}" (id: ${c.id}, categoryId: ${String(c.categoryId)})`
        );
      }
      if (missingCategory.length > 5) {
        console.log(`   ... and ${missingCategory.length - 5} more`);
      }
    } else {
      console.log("\n✅ Category joins are fine.");
    }

    // Step 2: Fix — backfill missing categoryIds with "General" category
    console.log(
      "\n🛠️  Fixing: backfilling missing categoryIds with 'General' category...\n"
    );

    const generalCategory = await prisma.communityCategory.findFirst({
      where: { slug: "general" },
      select: { id: true, name: true },
    });

    if (!generalCategory) {
      console.error("❌ 'General' category not found. Run: pnpm db:seed first");
      console.error("   Then re-run: pnpm fix:search");
      process.exit(1);
    }

    console.log(`✅ Found 'General' category: ${generalCategory.id}`);

    // Find communities whose category relation resolves to null
    const allCommunities = await prisma.community.findMany({
      where: { deletedAt: { isSet: false } },
      select: {
        id: true,
        name: true,
        categoryId: true,
        category: { select: { id: true } },
      },
    });

    const toFix = allCommunities.filter((c) => !c.category);

    if (toFix.length === 0) {
      console.log(
        "✅ All communities already have valid categoryIds — no fix needed\n"
      );
      console.log("🔎 Search issue may be caused by something else.");
      console.log(
        "   Try running: pnpm db:push  (to ensure Prisma indexes are up to date)"
      );
    } else {
      console.log(
        `🔧 Backfilling ${toFix.length} communities with 'General' category...`
      );

      const ids = toFix.map((c) => c.id);

      const batchSize = 50;
      let fixed = 0;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        await prisma.community.updateMany({
          where: { id: { in: batch } },
          data: {
            categoryId: generalCategory.id,
            categoryName: generalCategory.name,
          },
        });
        fixed += batch.length;
        console.log(`   Fixed ${fixed}/${toFix.length}...`);
      }

      console.log(
        `\n✅ Backfilled ${toFix.length} communities with 'General' category`
      );
    }

    // Step 3: Verify fix
    console.log("\n🔐 Verifying fix...\n");

    const afterFix = await prisma.community.count({
      where: {
        deletedAt: { isSet: false },
        status: { not: "CLOSED" },
      },
      // Re-run the same query as listDiscoverable to confirm all resolve
    });

    const verifyAll = await prisma.community.findMany({
      where: { deletedAt: { isSet: false }, status: { not: "CLOSED" } },
      select: { id: true, category: { select: { id: true } } },
    });

    const stillMissing = verifyAll.filter((c) => !c.category).length;

    console.log(`✅ Total active communities: ${afterFix}`);
    console.log(`✅ Still missing category:   ${stillMissing}`);

    if (stillMissing === 0) {
      console.log("\n🎉 All communities are now searchable!");
      console.log("\nTest with:");
      console.log(
        '   curl "https://your-api/api/v1/communities/mine?q=Vasu&filter=all"'
      );
    } else {
      console.log(`\n⚠️  ${stillMissing} communities still missing category.`);
      console.log("   Run: pnpm db:seed  then re-run: pnpm fix:search");
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixCommunitySearch();

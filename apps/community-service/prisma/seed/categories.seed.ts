import dotenv from "dotenv";

import { PrismaClient } from "../../src/generated/prisma/index.js";

// Load .env so the schema datasource `env("COMMUNITY_DATABASE_URL")` resolves
// with the full connection string (incl. directConnection=true for standalone
// Mongo). Without this the URL is undefined when run via `tsx`.
dotenv.config();

/**
 * Idempotent category seed — upsert by `slug`. Re-running keeps order/name
 * in sync without creating duplicates. Run via `pnpm db:seed`.
 */
const CATEGORIES: { name: string; slug: string }[] = [
  { name: "General", slug: "general" },
  { name: "Sports & Fitness", slug: "sports-and-fitness" },
  { name: "Gaming", slug: "gaming" },
  { name: "Music", slug: "music" },
  { name: "Education", slug: "education" },
  { name: "Technology", slug: "technology" },
  { name: "Art & Design", slug: "art-and-design" },
  { name: "Food & Cooking", slug: "food-and-cooking" },
  { name: "Travel", slug: "travel" },
  { name: "Business", slug: "business" },
];

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // NOTE: the local Mongo runs as a STANDALONE node (no replica set), so
  // Prisma `upsert` — which it implements via a transaction on Mongo — fails
  // with P2031. Seed idempotently with a non-transactional find → update/create
  // by the unique `slug` instead.
  for (let i = 0; i < CATEGORIES.length; i += 1) {
    const { name, slug } = CATEGORIES[i]!;
    const existing = await prisma.communityCategory.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (existing) {
      await prisma.communityCategory.update({
        where: { slug },
        data: { name, order: i, active: true },
      });
    } else {
      await prisma.communityCategory.create({
        data: { name, slug, order: i, active: true },
      });
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${String(CATEGORIES.length)} community categories.`);
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

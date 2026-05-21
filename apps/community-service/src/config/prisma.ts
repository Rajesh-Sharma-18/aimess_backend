import { logger } from "@aimess/logger";

import { PrismaClient } from "../generated/prisma/index.js";
import { env } from "./env.js";

const GLOBAL_KEY = "prisma_community_service";

type PrismaQueryEvent = { duration: number; query: string };

/**
 * MongoDB Prisma singleton. Mirrors the user-service style but WITHOUT the
 * Postgres driver adapter (`@aimess/prisma-pg` is Postgres-only). The Mongo
 * connection string is read from the datasource `url` in schema.prisma.
 *
 * Reuses one client across dev hot reloads (`tsx watch`); in production the
 * module singleton is enough so the global slot is not written.
 */
function createCommunityPrismaClient(): PrismaClient {
  try {
    const u = new URL(env.COMMUNITY_DATABASE_URL);
    logger.info(`Prisma: connecting to MongoDB at ${u.host}${u.pathname}`);
  } catch {
    logger.info("Prisma: connecting to MongoDB (invalid URL for display)");
  }

  const isDev = env.NODE_ENV === "development";

  const client = new PrismaClient({
    log: isDev
      ? [
          { emit: "event", level: "query" },
          { emit: "stdout", level: "error" },
          { emit: "stdout", level: "warn" },
        ]
      : [{ emit: "stdout", level: "error" }],
  });

  if (isDev) {
    client.$on("query", (e: PrismaQueryEvent) => {
      logger.debug(
        `Prisma query ${String(e.duration)}ms — ${e.query.slice(0, 200)}${
          e.query.length > 200 ? "…" : ""
        }`
      );
    });
  }

  return client;
}

const globalRecord = globalThis as unknown as Record<
  string,
  PrismaClient | undefined
>;

export const prisma: PrismaClient =
  globalRecord[GLOBAL_KEY] ?? createCommunityPrismaClient();

if (env.NODE_ENV !== "production") {
  globalRecord[GLOBAL_KEY] = prisma;
}

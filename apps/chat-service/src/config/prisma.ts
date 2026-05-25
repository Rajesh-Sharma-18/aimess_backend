import { PrismaClient } from "../generated/prisma/index.js";

import { logger } from "@aimess/logger";
import { env } from "./env.js";

const GLOBAL_KEY = "prisma_chat_service";

type PrismaQueryEvent = { duration: number; query: string };

function createChatPrismaClient(): PrismaClient {
  try {
    const u = new URL(env.MONGO_DATABASE_URL);
    logger.info(`Prisma: connecting to MongoDB at ${u.host}${u.pathname}`);
  } catch {
    logger.info("Prisma: connecting to MongoDB (invalid URL for display)");
  }

  const isDev = env.NODE_ENV === "development";

  const client = new PrismaClient({
    datasourceUrl: env.MONGO_DATABASE_URL,
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
  globalRecord[GLOBAL_KEY] ?? createChatPrismaClient();

if (env.NODE_ENV !== "production") {
  globalRecord[GLOBAL_KEY] = prisma;
}

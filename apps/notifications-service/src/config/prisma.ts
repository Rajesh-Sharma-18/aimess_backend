import { logger } from "@aimess/logger";

import { PrismaClient } from "../generated/prisma/index.js";
import { env } from "./env.js";

const GLOBAL_KEY = "prisma_notifications_service";

type PrismaQueryEvent = { duration: number; query: string };

function createNotificationsPrismaClient(): PrismaClient {
  try {
    const u = new URL(env.MONGO_DATABASE_URL);
    logger.info(`Prisma: connecting to MongoDB at ${u.host}${u.pathname}`);
  } catch {
    logger.info("Prisma: connecting to MongoDB (invalid URL for display)");
  }

  const isDev = env.NODE_ENV === "development";

  const mongoUrl = env.MONGO_DATABASE_URL.includes("maxPoolSize")
    ? env.MONGO_DATABASE_URL
    : env.MONGO_DATABASE_URL +
      (env.MONGO_DATABASE_URL.includes("?") ? "&" : "?") +
      "maxPoolSize=20";

  const client = new PrismaClient({
    datasourceUrl: mongoUrl,
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
  globalRecord[GLOBAL_KEY] ?? createNotificationsPrismaClient();

if (env.NODE_ENV !== "production") {
  globalRecord[GLOBAL_KEY] = prisma;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("notifications-service MongoDB connected via Prisma");
  } catch (error) {
    logger.error("notifications-service MongoDB connection failed", error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors during shutdown
  }
}

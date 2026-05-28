import { logger } from "@aimess/logger";

import { prisma } from "./prisma.js";

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("MongoDB connected via Prisma");
  } catch (error) {
    logger.error("MongoDB connection failed", error);
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

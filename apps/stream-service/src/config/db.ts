import { logger } from "@aimess/logger";

import { env } from "./env.js";
import { prisma } from "./prisma.js";

/**
 * Extract the real, human-readable cause from whatever Prisma throws on a
 * failed connect. Prisma wraps the driver failure (e.g. "Server selection
 * timeout: No available servers. ... I/O error: unexpected end of file") in a
 * PrismaClientKnownRequestError / PrismaClientInitializationError. Without this
 * the caller only ever sees the generic wrapper — and downstream callers (the
 * api-gateway gRPC client) then only surface "unavailable", hiding the actual
 * MongoDB connection error. This digs the underlying message back out so the
 * logs point straight at the root cause (bad host/port, replica set not ready,
 * auth failure, Mongo still booting, ...).
 */
function describeConnectError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? ` — cause: ${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

function safeMongoTarget(): string {
  try {
    const u = new URL(env.STREAM_DATABASE_URL);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable STREAM_DATABASE_URL)";
  }
}

/**
 * Connect to MongoDB with bounded retry + backoff.
 *
 * At boot the Mongo container may still be starting, electing a primary, or
 * finishing replica-set init — a single `$connect()` then throws
 * "Server selection timeout / No available servers / unexpected end of file"
 * and crashes the whole service before it can serve anything. stream-service
 * is not itself a docker-compose service (only infra is containerized), so
 * there is no `depends_on: condition: service_healthy` gate available either.
 * Retrying with a capped backoff lets the service ride out that startup
 * window instead of dying, while still failing loudly (with the real error)
 * if Mongo is genuinely misconfigured or unreachable.
 */
export async function connectDatabase(): Promise<void> {
  const maxAttempts = 15;
  const baseDelayMs = 1000;
  const maxDelayMs = 10_000;
  const target = safeMongoTarget();

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await prisma.$connect();
      logger.info(
        `MongoDB connected via Prisma (${target})` +
          (attempt > 1 ? ` after ${String(attempt)} attempts` : "")
      );
      return;
    } catch (error) {
      lastError = error;
      const detail = describeConnectError(error);

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * attempt, maxDelayMs);
        logger.warn(
          `MongoDB connection attempt ${String(attempt)}/${String(
            maxAttempts
          )} to ${target} failed — retrying in ${String(delay)}ms. ${detail}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      logger.error(
        `MongoDB connection failed after ${String(
          maxAttempts
        )} attempts to ${target}. Real error: ${detail}`
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`MongoDB connection failed: ${String(lastError)}`);
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore disconnect errors during shutdown
  }
}

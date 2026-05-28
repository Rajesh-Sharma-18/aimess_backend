import { PrismaPg } from "@prisma/adapter-pg";
import type { Logger } from "@aimess/logger";

/** Minimal surface used for Prisma query logging in development. */
export type PrismaQueryEvent = {
  duration: number;
  query: string;
};

/** Narrow enough for dev query logging without importing generated Prisma types. */
export type PrismaClientWithQueryEvents = {
  $on(event: "query", callback: (e: PrismaQueryEvent) => void): unknown;
};

/**
 * Each service passes its own generated `PrismaClient` class; this helper wires
 * the Postgres driver adapter, logging, and optional dev hot-reload singleton.
 */
export type CreatePostgresPrismaClientOptions<
  TClient extends PrismaClientWithQueryEvents,
> = {
  PrismaClient: new (options: {
    adapter: PrismaPg;
    log: Array<{ emit: "event" | "stdout"; level: "query" | "error" | "warn" }>;
  }) => TClient;
  connectionString: string;
  nodeEnv: string;
  logger: Pick<Logger, "info" | "debug">;
};

export function createPostgresPrismaClient<
  TClient extends PrismaClientWithQueryEvents,
>(options: CreatePostgresPrismaClientOptions<TClient>): TClient {
  const { PrismaClient, connectionString, nodeEnv, logger } = options;

  try {
    const u = new URL(connectionString);
    logger.info(`Prisma: connecting to PostgreSQL at ${u.host}${u.pathname}`);
  } catch {
    logger.info("Prisma: connecting to PostgreSQL (invalid URL for display)");
  }

  const adapter = new PrismaPg({ connectionString });
  const isDev = nodeEnv === "development";

  const client = new PrismaClient({
    adapter,
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
        `Prisma query ${e.duration}ms — ${e.query.slice(0, 200)}${e.query.length > 200 ? "…" : ""}`
      );
    });
  }

  return client;
}

/**
 * Reuse one client across dev hot reloads (`tsx watch`). In production the
 * module singleton is enough, so the global slot is not written.
 */
export function getOrCreatePostgresPrismaClient<TClient>(
  globalKey: string,
  nodeEnv: string,
  factory: () => TClient
): TClient {
  const globalRecord = globalThis as unknown as Record<
    string,
    TClient | undefined
  >;
  const existing = globalRecord[globalKey];
  if (existing) {
    return existing;
  }
  const client = factory();
  if (nodeEnv !== "production") {
    globalRecord[globalKey] = client;
  }
  return client;
}

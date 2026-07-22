import { logger } from "@aimess/logger";

/**
 * Minimal shape needed from the Prisma client — decoupled from the concrete
 * generated client type so this helper stays reusable across services.
 */
interface RunCommandCapable {
  $runCommandRaw(command: Record<string, unknown>): Promise<unknown>;
}

export interface MongoIndexSpec {
  key: Record<string, 1 | -1 | "text">;
  name: string;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
  collation?: Record<string, unknown>;
}

interface RawIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
  collation?: Record<string, unknown>;
}

function rawCommandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const meta = (error as { meta?: { message?: unknown } }).meta;
  if (typeof meta?.message === "string") return meta.message;
  if (error instanceof Error) return error.message;
  return "";
}

function isMongoNotPrimaryError(error: unknown): boolean {
  return /not primary|not writable primary/i.test(
    rawCommandErrorMessage(error)
  );
}

// MongoDB treats {a:1,b:1} and {b:1,a:1} as different indexes — key order
// matters, so plain JSON.stringify (which preserves insertion order for
// string keys) is a valid equality check here.
function sameKeyPattern(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameOptions(existing: RawIndexInfo, spec: MongoIndexSpec): boolean {
  return (
    Boolean(existing.unique) === Boolean(spec.unique) &&
    Boolean(existing.sparse) === Boolean(spec.sparse) &&
    JSON.stringify(existing.partialFilterExpression ?? null) ===
      JSON.stringify(spec.partialFilterExpression ?? null) &&
    (existing.expireAfterSeconds ?? null) ===
      (spec.expireAfterSeconds ?? null) &&
    JSON.stringify(existing.collation ?? null) ===
      JSON.stringify(spec.collation ?? null)
  );
}

async function listIndexes(
  prisma: RunCommandCapable,
  collection: string
): Promise<RawIndexInfo[]> {
  try {
    const result = (await prisma.$runCommandRaw({
      listIndexes: collection,
    })) as { cursor?: { firstBatch?: RawIndexInfo[] } };
    return result.cursor?.firstBatch ?? [];
  } catch (error) {
    // A collection that doesn't exist yet has no indexes — createIndexes
    // creates the collection implicitly, so this isn't an error condition.
    if (/ns does not exist|ns not found/i.test(rawCommandErrorMessage(error))) {
      return [];
    }
    throw error;
  }
}

/**
 * Idempotently ensures a MongoDB index exists, matched by KEY PATTERN rather
 * than name. MongoDB refuses to create a second index with an identical key
 * pattern under a different name (IndexOptionsConflict / error 85), so if any
 * existing index already covers this key pattern we reuse it silently instead
 * of attempting — and failing — a redundant create. This is also why Prisma's
 * MongoDB connector can't own index lifecycle itself: it only knows
 * create/drop by name, not "an equivalent index already exists elsewhere."
 */
export async function ensureMongoIndex(
  prisma: RunCommandCapable,
  collection: string,
  spec: MongoIndexSpec
): Promise<void> {
  const existing = await listIndexes(prisma, collection);
  const match = existing.find((idx) => sameKeyPattern(idx.key, spec.key));

  if (match) {
    if (match.name === spec.name) {
      logger.info(`Index ready: ${spec.name}`);
    } else {
      logger.info(
        `Index ready: ${spec.name} (reusing existing index "${match.name}" — same key pattern)`
      );
      if (!sameOptions(match, spec)) {
        logger.warn(
          `Index "${match.name}" shares the key pattern of "${spec.name}" but its options (unique/sparse/partialFilterExpression/TTL/collation) differ — review manually; not recreating.`
        );
      }
    }
    return;
  }

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await prisma.$runCommandRaw({
        createIndexes: collection,
        indexes: [
          {
            key: spec.key,
            name: spec.name,
            ...(spec.unique ? { unique: true } : {}),
            ...(spec.sparse ? { sparse: true } : {}),
            ...(spec.partialFilterExpression
              ? { partialFilterExpression: spec.partialFilterExpression }
              : {}),
            ...(spec.expireAfterSeconds !== undefined
              ? { expireAfterSeconds: spec.expireAfterSeconds }
              : {}),
            ...(spec.collation ? { collation: spec.collation } : {}),
          },
        ],
      });
      logger.info(`Index created: ${spec.name}`);
      return;
    } catch (error) {
      if (isMongoNotPrimaryError(error) && attempt < maxAttempts) {
        const delay = 1000 * attempt;
        logger.warn(
          `MongoDB not primary yet for ${spec.name}, retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Drops an index only if it's actually present. Existence is checked via
 * listIndexes first, so a missing index never reaches MongoDB's dropIndexes
 * command and never produces an IndexNotFound (error 27) anywhere.
 */
export async function dropMongoIndexIfExists(
  prisma: RunCommandCapable,
  collection: string,
  indexName: string
): Promise<void> {
  const existing = await listIndexes(prisma, collection);
  if (!existing.some((idx) => idx.name === indexName)) return;

  await prisma.$runCommandRaw({
    dropIndexes: collection,
    index: indexName,
  });
  logger.info(`Stale index dropped: ${indexName}`);
}

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

// MongoDB rejects a second index with an identical key pattern under a
// different name (IndexOptionsConflict / error 85) — the conflicting index's
// own name is embedded in the driver's error text, e.g. "Index already
// exists with a different name: <name>". Extracting it lets us log a clean
// "reusing X" message instead of a bare conflict warning.
function extractConflictingIndexName(message: string): string | null {
  const match = /different name:\s*([^\s,)]+)/i.exec(message);
  return match?.[1] ?? null;
}

function isIndexOptionsConflict(error: unknown): boolean {
  return /IndexOptionsConflict|already exists with a different/i.test(
    rawCommandErrorMessage(error)
  );
}

function isIndexNotFoundError(error: unknown): boolean {
  return /IndexNotFound|index not found/i.test(rawCommandErrorMessage(error));
}

/**
 * Idempotently ensures a MongoDB index exists.
 *
 * Note: this deliberately never calls `listIndexes` to pre-check — that
 * command returns a cursor-shaped response, and Prisma's `$runCommandRaw`
 * cannot deserialize cursor responses over MongoDB (it throws "Unknown
 * tagged value" trying to decode the tagged BSON in `cursor.firstBatch`).
 * Instead this is purely reactive: attempt the create, and if MongoDB
 * reports IndexOptionsConflict (error 85 — an equivalent index already
 * exists under a different name), treat that as success and reuse the
 * existing index rather than retrying or attempting to drop/recreate it.
 */
export async function ensureMongoIndex(
  prisma: RunCommandCapable,
  collection: string,
  spec: MongoIndexSpec
): Promise<void> {
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
      logger.info(`Index ready: ${spec.name}`);
      return;
    } catch (error) {
      if (isIndexOptionsConflict(error)) {
        const existingName = extractConflictingIndexName(
          rawCommandErrorMessage(error)
        );
        logger.info(
          existingName
            ? `Index ready: ${spec.name} (reusing existing index "${existingName}" — same key pattern)`
            : `Index ready: ${spec.name} (equivalent index already exists under another name)`
        );
        return;
      }
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
 * Drops an index only if it's actually present. Reactive, same reasoning as
 * `ensureMongoIndex` — no `listIndexes` pre-check. A missing index (error 27
 * — IndexNotFound) is caught and swallowed silently instead of surfacing.
 */
export async function dropMongoIndexIfExists(
  prisma: RunCommandCapable,
  collection: string,
  indexName: string
): Promise<void> {
  try {
    await prisma.$runCommandRaw({
      dropIndexes: collection,
      index: indexName,
    });
    logger.info(`Stale index dropped: ${indexName}`);
  } catch (error) {
    if (isIndexNotFoundError(error)) return;
    throw error;
  }
}

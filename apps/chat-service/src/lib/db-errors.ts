/**
 * Database error predicates shared across chat-service repositories/services.
 */

/**
 * True when `err` is a unique-constraint / duplicate-key violation, whether it
 * surfaced as a Prisma known-request error (`P2002`) or a raw MongoDB driver
 * error (`E11000`, numeric code `11000`).
 *
 * The chat idempotency indexes (e.g. `private_messages_idempotency_idx` on
 * `{ roomId, senderId, clientMessageId }`) are created out-of-band via
 * `$runCommandRaw` at startup (see `src/server.ts`), so they are NOT part of the
 * Prisma schema. A violating insert can therefore surface either as Prisma's
 * mapped `P2002` or — for an index the query engine doesn't model — the
 * underlying Mongo `E11000`. Callers use this to collapse a concurrent
 * same-`clientMessageId` send into the idempotent "already sent" re-read instead
 * of letting it bubble up as a 500 / SERVICE_ERROR.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  // Prisma unique-constraint violation (schema-modelled indexes).
  if (e.code === "P2002") return true;
  // Raw MongoServerError duplicate key (numeric code or string form).
  if (e.code === 11000 || e.code === "11000") return true;
  return typeof e.message === "string" && e.message.includes("E11000");
}

/**
 * True when `err` is a transient MongoDB write-conflict / deadlock that Prisma
 * surfaces as `P2034` ("Transaction failed due to a write conflict or a
 * deadlock. Please retry your transaction."), or the raw Mongo WriteConflict
 * (numeric code `112` / `codeName: "WriteConflict"`).
 *
 * MongoDB/WiredTiger uses optimistic concurrency control: concurrent writes to
 * the SAME document race, and because Prisma's Mongo connector runs each write
 * transactionally, the loser gets a retryable conflict instead of being
 * auto-retried by the server. This bites the hot per-room writes — a burst of
 * sends each `$inc`-ing one room's `lastSequence` (allocateSequence) or bumping
 * its last-message — where rapid/concurrent messages otherwise fail the send
 * with a user-visible retryable SERVICE_ERROR. Callers wrap such writes in
 * `withWriteConflictRetry` instead of failing.
 */
export function isWriteConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown };
  // Prisma transient transaction failure (write conflict / deadlock).
  if (e.code === "P2034") return true;
  // Raw MongoServerError write conflict (numeric code or label).
  if (e.code === 112 || e.code === "112") return true;
  if (e.codeName === "WriteConflict") return true;
  return (
    typeof e.message === "string" &&
    (e.message.includes("WriteConflict") ||
      e.message.includes("write conflict") ||
      e.message.includes("Please retry your transaction"))
  );
}

/**
 * Run `op`, retrying up to `attempts` times on a transient write-conflict
 * (`isWriteConflictError`) with a small randomized exponential backoff. Any
 * other error — and a conflict that survives every attempt — is rethrown
 * unchanged so callers' existing error handling is unaffected.
 *
 * The jitter de-correlates racing senders so they don't all retry in lockstep
 * and re-collide. Defaults (5 attempts, ~10/20/40/80ms capped at 100ms +
 * jitter) comfortably absorb a human typing/pasting a burst into one room.
 */
export async function withWriteConflictRetry<T>(
  op: () => Promise<T>,
  attempts = 5
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      lastErr = err;
      const base = Math.min(10 * 2 ** attempt, 100);
      const delay = base + Math.floor(Math.random() * base);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

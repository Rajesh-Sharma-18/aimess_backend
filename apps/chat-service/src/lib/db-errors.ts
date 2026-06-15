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

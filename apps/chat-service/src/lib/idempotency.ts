/**
 * Transient marker that flags a message object as an IDEMPOTENT REPLAY — i.e. a
 * `*MessageService.sendMessage`/`forwardMessage` call returned a PRE-EXISTING
 * row (a pre-send dedup hit, or a duplicate-key collapse of a concurrent
 * same-`clientMessageId` send) rather than a freshly-inserted one.
 *
 * The gRPC send handler reads this to skip the live fan-out (`message:new`
 * broadcast, `conv:updated` bump, push) that the message's FIRST send already
 * performed. Without it, N concurrent sends sharing one `clientMessageId` each
 * re-broadcast the same row, so a receiver sees N copies of one message.
 *
 * Implemented as a `Symbol` so it never leaks into `JSON.stringify`, object
 * spreads, or Prisma writes — it rides on the in-memory object only and is
 * invisible to every wire/serialization path.
 */
const REPLAY = Symbol.for("aimess.chat.idempotentReplay");

/** Tag `msg` as an idempotent replay and return it (for `return mark(x)`). */
export function markIdempotentReplay<T extends object>(msg: T): T {
  (msg as Record<symbol, unknown>)[REPLAY] = true;
  return msg;
}

/** True when `msg` was tagged by {@link markIdempotentReplay}. */
export function isIdempotentReplay(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<symbol, unknown>)[REPLAY] === true
  );
}

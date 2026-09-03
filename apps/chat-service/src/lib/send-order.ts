/**
 * Per-(room, sender) send ordering.
 *
 * A room's sequence numbers are handed out by `allocateRoomSlot`, which is FIFO
 * by the order senders REACH it — not by the order their messages arrived. Each
 * send does several reads first (rate limit, sender identity, membership,
 * idempotency, and for a group the delivery roster), and concurrent sends from
 * one person can finish those out of order, so the later message can reach the
 * allocator first and be stamped with the lower sequence. The transcript is
 * ordered by that sequence, so the two messages swap places for everyone.
 * Measured with the client pipelining and no ordering here: 2 inversions in 30
 * messages at a plainly human 10/s.
 *
 * WHAT IS ORDERED, AND WHAT IS NOT. Only the sequence allocation is. The first
 * version of this serialized the WHOLE send — correct, but it made one sender's
 * throughput the reciprocal of a full send (~250ms here, so ~4/s), which is
 * below what a person can type: the send queue still backed up and the composer
 * still showed the "Sending" clock. The reads do not decide order, so they no
 * longer wait for each other; a send takes its ticket on arrival, does its reads
 * concurrently with every other send from that person, and only blocks at the
 * allocator until the sends that arrived before it have taken their numbers.
 *
 * The ticket must be taken BEFORE the handler's first `await`, or the arrival
 * order it exists to capture has already been lost.
 *
 * It rides an AsyncLocalStorage rather than a parameter threaded through three
 * message services, the same way `runWithAuditContext` and `runWithLocale` carry
 * request context in @aimess/constants. `allocateRoomSlot` reads it; nothing
 * else has to know it exists, and a caller with no ticket (REST, tests, the
 * system-message paths) is simply unordered, exactly as before.
 *
 * ponytail: in-process, like `room-lock.ts` next door, and for the same reason —
 * two chat-service instances each keep their own chain. A single client's socket
 * lands on one instance, which is the case this orders; correctness of the
 * sequence itself never depended on this, only its agreement with typing order.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface SendTurn {
  /** Resolves once every send that arrived earlier has taken its sequence. */
  readonly ready: Promise<void>;
  /** Lets the next send allocate. Idempotent. */
  release(): void;
  /** Whether this send has already waited — an album allocates in a loop. */
  waited: boolean;
}

const turnStore = new AsyncLocalStorage<SendTurn>();

/** Tail of the queue for each active (room, sender). Absent means idle. */
const tails = new Map<string, Promise<void>>();

/**
 * Give `fn` a place in this (room, sender)'s order and run it. The place is
 * taken synchronously, so callers MUST invoke this before their first `await`.
 *
 * The turn is released either by the allocator (the moment this send's sequence
 * is decided) or, if this send never gets that far — rate limited, rejected, an
 * idempotent replay — when `fn` settles. Without that second release a refused
 * send would park every later message from the same person forever.
 */
export function withSendOrder<T>(
  roomId: string,
  senderId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${roomId} ${senderId}`;
  const ready = tails.get(key) ?? Promise.resolve();

  let releaseTurn!: () => void;
  const done = new Promise<void>((resolve) => {
        releaseTurn = resolve;
    });

  let released = false;
  const turn: SendTurn = {
    ready,
    release() {
      if (released) return;
      released = true;
      releaseTurn();
    },
    waited: false,
  };

  tails.set(key, done);
  void done.then(() => {
    // Last one out clears the entry, so the map cannot grow one key per
    // (room, sender) this process has ever seen.
    if (tails.get(key) === done) tails.delete(key);
  });

  return turnStore.run(turn, fn).finally(() => turn.release());
}

/**
 * Called by `allocateRoomSlot`: block until it is this send's turn to take a
 * sequence number. A no-op when there is no ticket, and after the first
 * allocation of an album — the order is decided by the first row.
 */
export async function awaitSendTurn(): Promise<void> {
  const turn = turnStore.getStore();
  if (!turn || turn.waited) return;
  turn.waited = true;
  await turn.ready;
}

/** Called by `allocateRoomSlot` once a sequence is in hand. */
export function releaseSendTurn(): void {
  turnStore.getStore()?.release();
}

/** Test seam: number of (room, sender) pairs with a send still in flight. */
export function activeSendOrderKeys(): number {
  return tails.size;
}

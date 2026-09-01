/**
 * Per-room sequence/revision allocation: serialized AND batched.
 *
 * Every private send has to `$inc` the same PrivateRoom document. Two things
 * used to go wrong under a burst to one conversation:
 *
 *  1. N concurrent writers raced for one document. Mongo serializes them
 *     anyway, and each loser burned a WriteConflict retry — a whole extra
 *     round trip — before getting back in line. Measured on a 24-way burst:
 *     the `$inc` alone averaged 5.9s, with a 16s tail.
 *  2. Even perfectly serialized, one round trip per message caps a single room
 *     at ~1/RTT sends per second (~11/s against the remote Mongo here).
 *
 * So requests that arrive while an allocation is in flight are collected and
 * satisfied by ONE `$inc` of the whole batch — a burst pays for one round trip
 * instead of one per message. Different rooms never wait on each other.
 *
 * ponytail: in-process only. Multiple chat-service instances each keep their
 * own queue, which still removes most contention but is not a cluster-wide
 * lock; the `$inc` stays atomic either way, so correctness does not depend on
 * this — only throughput does.
 */
export interface AllocatedSlot<TRoom> {
  sequenceNumber: number;
  /**
   * 0 when the allocator does not hand out revisions. Group insert bumps only
   * `lastSequence` — its `/changes` cursor is advanced elsewhere — so a group
   * slot carries no revision and callers must not persist this as one.
   */
  revision: number;
  room: TRoom;
}

type Waiter<TRoom> = {
  resolve: (slot: AllocatedSlot<TRoom>) => void;
  reject: (err: unknown) => void;
};

type BlockAllocator<TRoom> = (
  roomId: string,
  count: number
) => Promise<{
  lastSequence: number;
  /** Omit when the room's revision counter was not incremented by this block. */
  lastRevision?: number;
  room: TRoom;
}>;

const pending = new Map<string, Waiter<unknown>[]>();
const draining = new Set<string>();

async function drain<TRoom>(
  roomId: string,
  allocateBlock: BlockAllocator<TRoom>
): Promise<void> {
  if (draining.has(roomId)) return;
  draining.add(roomId);
  try {
    for (;;) {
      const batch = pending.get(roomId);
      if (!batch || batch.length === 0) break;
      // Take everything waiting right now; anything that arrives during the
      // round trip forms the next batch.
      pending.delete(roomId);
      try {
        const block = await allocateBlock(roomId, batch.length);
        const firstSeq = block.lastSequence - batch.length + 1;
        // No revision block means this room does not allocate revisions on
        // insert; hand out 0 rather than a plausible-looking wrong number.
        const firstRev =
          block.lastRevision === undefined
            ? undefined
            : block.lastRevision - batch.length + 1;
        batch.forEach((waiter, i) =>
          waiter.resolve({
            sequenceNumber: firstSeq + i,
            revision: firstRev === undefined ? 0 : firstRev + i,
            room: block.room,
          } as AllocatedSlot<unknown>)
        );
      } catch (err) {
        batch.forEach((waiter) => waiter.reject(err));
      }
    }
  } finally {
    draining.delete(roomId);
    // A waiter enqueued between the last check and this line would otherwise
    // sit forever with no drain running.
    if ((pending.get(roomId)?.length ?? 0) > 0) {
      void drain(roomId, allocateBlock);
    }
  }
}

export function allocateRoomSlot<TRoom>(
  roomId: string,
  allocateBlock: BlockAllocator<TRoom>
): Promise<AllocatedSlot<TRoom>> {
  return new Promise<AllocatedSlot<TRoom>>((resolve, reject) => {
    const queue = pending.get(roomId) ?? [];
    queue.push({ resolve, reject } as Waiter<unknown>);
    pending.set(roomId, queue);
    void drain(roomId, allocateBlock);
  }) as Promise<AllocatedSlot<TRoom>>;
}

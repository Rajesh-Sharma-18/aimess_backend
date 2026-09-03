/**
 * `withSendOrder` is what lets the web client keep several sends in flight
 * without the transcript reordering. Two messages from one person could reach
 * `allocateRoomSlot` out of order — measured with the client pipelining and no
 * ordering here, 2 of 30 messages came back with swapped sequence numbers at a
 * plainly human 10/s.
 *
 * The property under test is narrow on purpose: the ALLOCATION is ordered, the
 * reads around it are not. Serializing the whole send also fixes the ordering,
 * and that is what the first version did — but it capped one sender at the
 * reciprocal of a full send (~4/s here), which is slower than a person types, so
 * the queue still backed up and the clock still showed.
 */
import { allocateRoomSlot } from "../../src/lib/room-lock.js";
import {
  withSendOrder,
  activeSendOrderKeys,
} from "../../src/lib/send-order.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for the room `$inc`: hands out a contiguous block each call. */
function makeAllocator() {
  let last = 0;
  return async (_roomId: string, count: number) => {
    await tick(2);
    last += count;
    return { lastSequence: last, room: {} };
  };
}

describe("withSendOrder", () => {
  it("allocates sequences in arrival order even when the reads finish out of order", async () => {
    const allocate = makeAllocator();
    const got: Array<{ arrived: number; seq: number }> = [];

    // Descending read times: without ordering, #3 reaches the allocator first
    // and takes sequence 1.
    const readTimes = [40, 25, 5];
    await Promise.all(
      readTimes.map((ms, i) =>
        withSendOrder("room-1", "alice", async () => {
          await tick(ms); // the identity / membership / idempotency reads
          const slot = await allocateRoomSlot("room-1", allocate);
          got.push({ arrived: i + 1, seq: slot.sequenceNumber });
        })
      )
    );

    got.sort((a, b) => a.seq - b.seq);
    expect(got.map((g) => g.arrived)).toEqual([1, 2, 3]);
  });

  it("lets the reads of concurrent sends overlap", async () => {
    const allocate = makeAllocator();
    let reading = 0;
    let peakReading = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        withSendOrder("room-2", "alice", async () => {
          reading += 1;
          peakReading = Math.max(peakReading, reading);
          await tick(20);
          reading -= 1;
          await allocateRoomSlot("room-2", allocate);
        })
      )
    );

    // Serializing the whole send — the thing that made the composer show a
    // clock — would pin this at 1.
    expect(peakReading).toBeGreaterThan(1);
  });

  it("does not make different senders or different rooms wait on each other", async () => {
    const allocate = makeAllocator();
    let inFlight = 0;
    let peak = 0;
    const send = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(15);
      inFlight -= 1;
    };

    await Promise.all([
      withSendOrder("room-3", "alice", send),
      withSendOrder("room-3", "bob", send),
      withSendOrder("room-4", "alice", send),
    ]);

    expect(peak).toBe(3);
    expect(allocate).toBeDefined();
  });

  it("releases the turn when a send never reaches the allocator", async () => {
    const allocate = makeAllocator();
    const ran: string[] = [];

    // Refused before allocating — a rate limit, a membership rejection, an
    // idempotent replay. Without a release here every later message from this
    // person would wait forever.
    const refused = withSendOrder("room-5", "alice", async () => {
      ran.push("refused");
      throw new Error("RATE_LIMITED");
    });
    const following = withSendOrder("room-5", "alice", async () => {
      ran.push("following");
      const slot = await allocateRoomSlot("room-5", allocate);
      return slot.sequenceNumber;
    });

    await expect(refused).rejects.toThrow("RATE_LIMITED");
    await expect(following).resolves.toBe(1);
    expect(ran).toEqual(["refused", "following"]);
  });

  it("forgets a (room, sender) once its sends drain, so the map cannot grow forever", async () => {
    const allocate = makeAllocator();
    const before = activeSendOrderKeys();
    await withSendOrder("room-6", "alice", async () => {
      await allocateRoomSlot("room-6", allocate);
    });
    await tick(5); // let the chain's own cleanup microtask run
    expect(activeSendOrderKeys()).toBe(before);
  });

  it("leaves a caller with no ticket completely unordered", async () => {
    // REST, system messages and tests call the allocator directly.
    const allocate = makeAllocator();
    const slots = await Promise.all([
      allocateRoomSlot("room-7", allocate),
      allocateRoomSlot("room-7", allocate),
    ]);
    expect(slots.map((s) => s.sequenceNumber).sort()).toEqual([1, 2]);
  });
});

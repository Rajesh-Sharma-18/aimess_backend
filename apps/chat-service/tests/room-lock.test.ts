import { allocateRoomSlot } from "../src/lib/room-lock.js";

describe("allocateRoomSlot", () => {
  it("batches concurrent waiters into one increment and hands out unique, gapless numbers", async () => {
    let counter = 0;
    let calls = 0;
    const allocate = async (_roomId: string, count: number) => {
      calls++;
      // Simulate the remote round trip so later waiters queue behind this one.
      await new Promise((r) => setTimeout(r, 20));
      counter += count;
      return { lastSequence: counter, lastRevision: counter, room: {} };
    };

    const slots = await Promise.all(
      Array.from({ length: 50 }, () => allocateRoomSlot("room-1", allocate))
    );

    const seqs = slots.map((s) => s.sequenceNumber).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(50);
    expect(seqs[0]).toBe(1);
    expect(seqs[49]).toBe(50);
    // The whole point: far fewer round trips than messages.
    expect(calls).toBeLessThan(50);
  });

  it("keeps the queue alive after a failed batch", async () => {
    let fail = true;
    let counter = 0;
    const allocate = async (_roomId: string, count: number) => {
      await new Promise((r) => setTimeout(r, 5));
      if (fail) {
        fail = false;
        throw new Error("write conflict");
      }
      counter += count;
      return { lastSequence: counter, lastRevision: counter, room: {} };
    };

    await expect(allocateRoomSlot("room-2", allocate)).rejects.toThrow(
      "write conflict"
    );
    const slot = await allocateRoomSlot("room-2", allocate);
    expect(slot.sequenceNumber).toBe(1);
  });

  // Group insert allocates sequence numbers but NOT revisions: its `/changes`
  // cursor is advanced by the edit/delete/reaction paths, so a send must not
  // move it. An allocator that reports no revision block must therefore hand
  // out 0 rather than a plausible-looking number derived from the room's
  // current revision — a wrong revision persisted onto a row would silently
  // corrupt every client's stored catch-up cursor.
  it("hands out revision 0 when the allocator reserves no revision block", async () => {
    let counter = 0;
    const allocate = async (_roomId: string, count: number) => {
      await new Promise((r) => setTimeout(r, 5));
      counter += count;
      return { lastSequence: counter, room: {} };
    };

    const slots = await Promise.all(
      Array.from({ length: 4 }, () => allocateRoomSlot("room-3", allocate))
    );

    expect(slots.map((s) => s.sequenceNumber).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(slots.every((s) => s.revision === 0)).toBe(true);
  });
});

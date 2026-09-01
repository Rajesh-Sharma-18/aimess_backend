/**
 * Burst coalescing for live message delivery.
 *
 * The one rule that must never bend: the first message of a quiet period leaves
 * IMMEDIATELY. Everything else the batcher does is an optimisation; that rule is
 * what keeps a single message as fast as it was before batching existed.
 */
import { createMessageBatcher } from "../../src/sockets/message-batcher.js";

const WINDOW = 300;

function harness() {
  const singles: Array<[string, unknown]> = [];
  const batches: Array<[string, unknown[]]> = [];
  const batcher = createMessageBatcher({
    windowMs: WINDOW,
    emitOne: (channel, data) => singles.push([channel, data]),
    emitBatch: (channel, batch) => batches.push([channel, batch]),
  });
  return { singles, batches, batcher };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("message batcher", () => {
  it("emits an isolated message immediately, never as a batch", () => {
    const { singles, batches, batcher } = harness();

    batcher.push("conv:a", { id: 1 });

    expect(singles).toEqual([["conv:a", { id: 1 }]]);
    jest.advanceTimersByTime(WINDOW * 3);
    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(1);
  });

  it("coalesces a burst into one batch behind the leading message, in order", () => {
    const { singles, batches, batcher } = harness();

    for (let i = 1; i <= 10; i++) batcher.push("conv:a", { id: i });

    expect(singles).toHaveLength(1);
    expect(singles[0][1]).toEqual({ id: 1 });
    jest.advanceTimersByTime(WINDOW);
    expect(batches).toHaveLength(1);
    expect(batches[0][1].map((m) => (m as { id: number }).id)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("delivers every message exactly once across window boundaries", () => {
    const { singles, batches, batcher } = harness();

    // One message per window, landing exactly on each flush.
    for (let i = 1; i <= 5; i++) {
      batcher.push("conv:a", { id: i });
      jest.advanceTimersByTime(WINDOW);
    }
    jest.advanceTimersByTime(WINDOW * 2);

    const seen = [
      ...singles.map(([, m]) => (m as { id: number }).id),
      ...batches.flatMap(([, b]) => b.map((m) => (m as { id: number }).id)),
    ].sort((a, b) => a - b);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("a window that held exactly one message emits it alone, not as a batch of one", () => {
    const { singles, batches, batcher } = harness();

    batcher.push("conv:a", { id: 1 });
    jest.advanceTimersByTime(WINDOW / 2);
    batcher.push("conv:a", { id: 2 });
    jest.advanceTimersByTime(WINDOW);

    expect(batches).toHaveLength(0);
    expect(singles.map(([, m]) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it("returns to leading-edge-immediate once the burst stops", () => {
    const { singles, batches, batcher } = harness();

    batcher.push("conv:a", { id: 1 });
    batcher.push("conv:a", { id: 2 });
    batcher.push("conv:a", { id: 3 });
    jest.advanceTimersByTime(WINDOW * 3); // burst ends, window closes
    expect(batches).toHaveLength(1);

    // A message after the quiet period is leading-edge again, not buffered.
    batcher.push("conv:a", { id: 4 });
    expect(singles.map(([, m]) => (m as { id: number }).id)).toEqual([1, 4]);
  });

  it("never mixes rooms, and a busy room does not delay a quiet one", () => {
    const { singles, batches, batcher } = harness();

    batcher.push("conv:a", { id: "a1" });
    batcher.push("conv:a", { id: "a2" });
    batcher.push("conv:a", { id: "a3" });
    batcher.push("conv:b", { id: "b1" });
    jest.advanceTimersByTime(WINDOW);

    // Leading edge of each room went out on its own, immediately.
    expect(singles.map(([c]) => c)).toEqual(["conv:a", "conv:b"]);
    // Only the busy room produced a batch, and it holds only its own messages.
    expect(batches).toHaveLength(1);
    expect(batches[0][0]).toBe("conv:a");
    expect(batches[0][1]).toEqual([{ id: "a2" }, { id: "a3" }]);
  });

  it("caps a runaway producer instead of building an unbounded frame", () => {
    const { batches, batcher } = harness();

    for (let i = 0; i < 250; i++) batcher.push("conv:a", { id: i });
    jest.advanceTimersByTime(WINDOW * 2);

    const sizes = batches.map(([, b]) => b.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total).toBe(249); // the leading one went out on its own
  });
});

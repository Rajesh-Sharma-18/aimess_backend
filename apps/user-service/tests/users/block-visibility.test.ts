/**
 * Block direction policy (`src/lib/block-visibility.ts`) — the single rule every
 * discovery surface subtracts by. Pure function, so tested directly; the
 * per-surface wiring is covered by the user-search / user-discovery suites.
 */
import { splitBlocks } from "../../src/lib/block-visibility.js";

const VIEWER = "viewer-id";
const OTHER = "other-id";

describe("splitBlocks", () => {
  it("hides users who blocked the viewer", () => {
    const { hiddenIds, blockedByMe } = splitBlocks(VIEWER, [
      { blockerId: OTHER, blockedId: VIEWER },
    ]);

    expect([...hiddenIds]).toEqual([OTHER]);
    expect([...blockedByMe]).toEqual([]);
  });

  it("keeps users the viewer blocked visible (one-way)", () => {
    const { hiddenIds, blockedByMe } = splitBlocks(VIEWER, [
      { blockerId: VIEWER, blockedId: OTHER },
    ]);

    // The blocker must still find, open and unblock who they blocked.
    expect([...hiddenIds]).toEqual([]);
    expect([...blockedByMe]).toEqual([OTHER]);
  });

  it("puts a mutual block in both sets", () => {
    const { hiddenIds, blockedByMe } = splitBlocks(VIEWER, [
      { blockerId: VIEWER, blockedId: OTHER },
      { blockerId: OTHER, blockedId: VIEWER },
    ]);

    // The other side's block still hides them — the viewer's own does not undo it.
    expect([...hiddenIds]).toEqual([OTHER]);
    expect([...blockedByMe]).toEqual([OTHER]);
  });

  it("ignores blocks between two other users", () => {
    const { hiddenIds, blockedByMe } = splitBlocks(VIEWER, [
      { blockerId: "a", blockedId: "b" },
    ]);

    expect(hiddenIds.size).toBe(0);
    expect(blockedByMe.size).toBe(0);
  });
});

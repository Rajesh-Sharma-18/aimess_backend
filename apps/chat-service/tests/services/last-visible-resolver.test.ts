/**
 * Unit tests for the shared LastVisibleResolver — the single, room-type-agnostic
 * "latest message visible to THIS user" engine that backs the community/private/
 * group list builders and the delete-for-me / delete-for-everyone socket fan-out.
 *
 * The resolver is pure orchestration over a `VisibilitySource` adapter, so these
 * tests mock that 3-method interface directly (no DB, no DI graph) and assert the
 * Phase-13 visibility matrix: hidden-last fallback, empty-room, was-effective-last
 * gating, and per-recipient delete-for-everyone overrides.
 */
import {
  resolveVisibleLastBulk,
  deletedWasEffectiveLast,
  resolveForEveryoneOverrides,
  type VisibilitySource,
  type VisibleLast,
} from "../../src/services/last-visible-resolver.js";

const USER = "user-a";

function msg(
  overrides: Partial<VisibleLast> & { messageId: string }
): VisibleLast {
  return {
    senderId: "s1",
    senderName: "Alice",
    messageType: "TEXT",
    content: "hello",
    createdAt: new Date(1_700_000_000_000),
    ...overrides,
  };
}

/** Build a VisibilitySource from plain maps so each test is fully declarative. */
function source(opts: {
  hidden?: Set<string>;
  prevByRoom?: Record<string, VisibleLast | null>;
  hidersByMessage?: Record<string, Set<string>>;
}): VisibilitySource {
  return {
    filterHidden: jest.fn(
      async (ids: string[]) => new Set(ids.filter((id) => opts.hidden?.has(id)))
    ),
    findPreviousVisibleForUser: jest.fn(
      async (roomId: string) => opts.prevByRoom?.[roomId] ?? null
    ),
    hidersAmong: jest.fn(async (messageId: string, userIds: string[]) => {
      const hid = opts.hidersByMessage?.[messageId] ?? new Set<string>();
      return new Set(userIds.filter((u) => hid.has(u)));
    }),
  };
}

describe("resolveVisibleLastBulk", () => {
  it("returns NO overrides when no shared last is hidden (common path)", async () => {
    const src = source({ hidden: new Set() });
    const out = await resolveVisibleLastBulk(
      src,
      [
        { roomId: "r1", sharedLastMessageId: "m1" },
        { roomId: "r2", sharedLastMessageId: "m2" },
      ],
      USER
    );
    expect(out.size).toBe(0);
    // No previous-visible lookups when nothing is hidden.
    expect(src.findPreviousVisibleForUser).not.toHaveBeenCalled();
  });

  it("substitutes the previous-visible message for a room whose shared last is hidden", async () => {
    const prev = msg({ messageId: "m0", content: "earlier" });
    const src = source({
      hidden: new Set(["m1"]),
      prevByRoom: { r1: prev },
    });
    const out = await resolveVisibleLastBulk(
      src,
      [
        { roomId: "r1", sharedLastMessageId: "m1" },
        { roomId: "r2", sharedLastMessageId: "m2" },
      ],
      USER
    );
    // Only the hidden room gets an entry; the visible room keeps its snapshot.
    expect(out.has("r2")).toBe(false);
    expect(out.get("r1")).toEqual(prev);
  });

  it("maps to null when the shared last is hidden and NOTHING visible remains", async () => {
    const src = source({ hidden: new Set(["m1"]), prevByRoom: { r1: null } });
    const out = await resolveVisibleLastBulk(
      src,
      [{ roomId: "r1", sharedLastMessageId: "m1" }],
      USER
    );
    expect(out.has("r1")).toBe(true);
    expect(out.get("r1")).toBeNull();
  });

  it("tolerates a source returning undefined from filterHidden (mock proxy)", async () => {
    const src: VisibilitySource = {
      filterHidden: jest.fn(async () => undefined as unknown as Set<string>),
      findPreviousVisibleForUser: jest.fn(async () => null),
      hidersAmong: jest.fn(async () => new Set<string>()),
    };
    const out = await resolveVisibleLastBulk(
      src,
      [{ roomId: "r1", sharedLastMessageId: "m1" }],
      USER
    );
    expect(out.size).toBe(0);
  });
});

describe("deletedWasEffectiveLast (the single was-last gate)", () => {
  const deletedAt = new Date(1_700_000_005_000);

  it("is TRUE when nothing visible remains (room emptied for the user)", () => {
    expect(deletedWasEffectiveLast(null, deletedAt)).toBe(true);
  });

  it("is TRUE when the newest visible is older than the deleted message (it WAS the last)", () => {
    expect(
      deletedWasEffectiveLast(new Date(1_700_000_004_000), deletedAt)
    ).toBe(true);
  });

  it("is TRUE on a same-millisecond tie (harmless extra refresh, never wrong)", () => {
    expect(
      deletedWasEffectiveLast(new Date(deletedAt.getTime()), deletedAt)
    ).toBe(true);
  });

  it("is FALSE when a visible message is NEWER than the deleted one (NOT the last)", () => {
    expect(
      deletedWasEffectiveLast(new Date(1_700_000_009_000), deletedAt)
    ).toBe(false);
  });
});

describe("resolveForEveryoneOverrides (per-recipient delete-for-everyone)", () => {
  it("returns NO overrides when nobody hid the shared previous-visible", async () => {
    const src = source({ hidersByMessage: { m0: new Set() } });
    const out = await resolveForEveryoneOverrides(src, "r1", "m0", [
      "u1",
      "u2",
      "u3",
    ]);
    expect(out.size).toBe(0);
  });

  it("gives a recipient who hid the shared previous-visible THEIR own preview", async () => {
    const theirPrev = msg({
      messageId: "m-older",
      senderName: "Bob",
      content: "their earlier message",
    });
    const src = source({
      hidersByMessage: { m0: new Set(["u2"]) },
      prevByRoom: { r1: theirPrev },
    });
    const out = await resolveForEveryoneOverrides(src, "r1", "m0", [
      "u1",
      "u2",
      "u3",
    ]);
    // Only the hider (u2) is overridden; the others use the shared preview.
    expect(out.has("u1")).toBe(false);
    expect(out.has("u3")).toBe(false);
    expect(out.get("u2")).toEqual({
      lastMessageId: "m-older",
      lastMessageAt: theirPrev.createdAt.getTime(),
      senderId: theirPrev.senderId,
      senderName: "Bob",
      messageType: "TEXT",
      content: "their earlier message",
      // Offline-first list identity — defaults when the fixture omits them.
      clientMessageId: null,
      sequenceNumber: 0,
      revision: 0,
    });
  });

  it("maps a hider with no remaining visible message to null (empty preview)", async () => {
    const src = source({
      hidersByMessage: { m0: new Set(["u2"]) },
      prevByRoom: { r1: null },
    });
    const out = await resolveForEveryoneOverrides(src, "r1", "m0", [
      "u1",
      "u2",
    ]);
    expect(out.get("u2")).toBeNull();
  });

  it("is a no-op when there is no shared previous-visible (room emptied)", async () => {
    const src = source({});
    const out = await resolveForEveryoneOverrides(src, "r1", null, [
      "u1",
      "u2",
    ]);
    expect(out.size).toBe(0);
    expect(src.hidersAmong).not.toHaveBeenCalled();
  });
});

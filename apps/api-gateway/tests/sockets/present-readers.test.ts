/**
 * Read-at-delivery presence selection — regression test.
 *
 * Bug: a community-invite DM raised the recipient's unread badge even when they
 * had that very chat open, and only entering the room again cleared it. The fix
 * has two halves; this covers the gateway half — deciding WHO was looking when
 * the message landed.
 *
 * The trap this test exists for: Socket.IO room membership is NOT presence. The
 * DM sidebar calls `conv:join` for every visible thread (typing indicators) and
 * the community sidebar subscribes to every community, so selecting on room
 * membership would mark most of the inbox read on the next message.
 */
import { presentReaders } from "../../src/sockets/present-readers.js";

const socket = (userId: string, active?: string) => ({
  data: { userId, ...(active ? { activeConvId: active } : {}) },
});

describe("presentReaders", () => {
  it("selects the viewer whose transcript is open on this room", () => {
    expect(
      presentReaders(
        [socket("bob", "prv_1")],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual(["bob"]);
  });

  it("does NOT select a socket that merely joined the room (sidebar typing subscription)", () => {
    expect(
      presentReaders([socket("bob")], "activeConvId", "prv_1", "alice")
    ).toEqual([]);
  });

  it("does NOT select a socket whose open transcript is a DIFFERENT room", () => {
    expect(
      presentReaders(
        [socket("bob", "prv_2")],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual([]);
  });

  it("never selects the sender, even with that room open in another tab", () => {
    expect(
      presentReaders(
        [socket("alice", "prv_1")],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual([]);
  });

  it("dedupes per user — read state is per-user, not per-device", () => {
    expect(
      presentReaders(
        [socket("bob", "prv_1"), socket("bob", "prv_1")],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual(["bob"]);
  });

  it("one present device is enough; the user's other devices need no mark of their own", () => {
    expect(
      presentReaders(
        [socket("bob", "prv_1"), socket("bob"), socket("carol")],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual(["bob"]);
  });

  it("ignores sockets with no resolved user (mid-handshake)", () => {
    expect(
      presentReaders(
        [{ data: { activeConvId: "prv_1" } }],
        "activeConvId",
        "prv_1",
        "alice"
      )
    ).toEqual([]);
  });

  it("reads the community key when asked to — same rule, other namespace", () => {
    expect(
      presentReaders(
        [
          { data: { userId: "bob", activeCommunityId: "c1" } },
          { data: { userId: "carol", activeConvId: "c1" } },
        ],
        "activeCommunityId",
        "c1",
        "alice"
      )
    ).toEqual(["bob"]);
  });
});

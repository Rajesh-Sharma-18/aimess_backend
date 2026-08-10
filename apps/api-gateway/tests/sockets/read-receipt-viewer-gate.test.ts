import type { Namespace } from "socket.io";

import { emitPersonalizedSender } from "../../src/sockets/emit-personalized.js";

/**
 * Recipient side of Settings → Chat → Read Receipt.
 *
 * chat-service already withholds the receipt of a READER who switched it off.
 * Reciprocity — a VIEWER who switched it off doesn't get to see anyone else's —
 * can only be enforced at delivery, because one `message:read` broadcast
 * reaches many viewers with different settings. That gate is `skipViewer`.
 */

function fakeNamespace(
  sockets: Array<{ data: { userId: string }; emit: jest.Mock }>
) {
  const chain = { emit: jest.fn() };
  return {
    ns: {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      }),
      to: jest.fn().mockReturnValue(chain),
    } as unknown as Namespace,
    chain,
  };
}

const socketFor = (userId: string) => ({ data: { userId }, emit: jest.fn() });

const READ = {
  conversationId: "prv_1",
  readerId: "reader",
  read_to_seq: 9,
};

describe("message:read viewer gate", () => {
  it("delivers to viewers who allow receipts and skips those who don't", async () => {
    const allowed = socketFor("viewer-on");
    const optedOut = socketFor("viewer-off");
    const { ns, chain } = fakeNamespace([allowed, optedOut]);

    await emitPersonalizedSender(
      ns,
      "conv:prv_1",
      "message:read",
      READ,
      undefined,
      undefined,
      async (viewerId) => viewerId === "viewer-off"
    );

    expect(allowed.emit).toHaveBeenCalledWith("message:read", READ);
    expect(optedOut.emit).not.toHaveBeenCalled();
    // Never a room-wide broadcast — that would reach the opted-out socket.
    expect(chain.emit).not.toHaveBeenCalled();
  });

  it("does NOT fall back to a room broadcast when the socket scan fails", async () => {
    const chain = { emit: jest.fn() };
    const ns = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockRejectedValue(new Error("adapter down")),
      }),
      to: jest.fn().mockReturnValue(chain),
    } as unknown as Namespace;

    await emitPersonalizedSender(
      ns,
      "conv:prv_1",
      "message:read",
      READ,
      undefined,
      undefined,
      async () => true
    );

    // Falling back here would leak the receipt to everyone, including the very
    // viewers the gate exists to skip.
    expect(chain.emit).not.toHaveBeenCalled();
  });

  it("leaves every other event on the plain broadcast path", async () => {
    const chain = { emit: jest.fn() };
    const ns = {
      in: jest.fn(),
      to: jest.fn().mockReturnValue(chain),
    } as unknown as Namespace;

    await emitPersonalizedSender(ns, "conv:prv_1", "message:new", {
      id: "m1",
    });

    expect(chain.emit).toHaveBeenCalledWith("message:new", { id: "m1" });
    expect(ns.in).not.toHaveBeenCalled();
  });
});

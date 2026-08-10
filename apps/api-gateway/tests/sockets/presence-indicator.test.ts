import type { Namespace, Socket } from "socket.io";

import {
  createPresenceIndicator,
  createDirectRosterBroadcast,
  createRoomBroadcast,
  PRESENCE_TTL_MS,
} from "../../src/sockets/presence-indicator.js";

/**
 * Unit coverage for the shared presence engine that /chat and /community typing
 * + recording now both run on. The namespace-level behaviour (event names,
 * payload shape, sender exclusion) is already covered by community-typing and
 * recording-presence; this pins the mechanics that were extracted OUT of both:
 * TTL auto-stop, re-arming, disconnect flush, and the roster gate.
 */

const flushAsync = () => new Promise((r) => setImmediate(r));

function fakeNamespace(sockets: Array<{ id: string; emit: jest.Mock }> = []) {
  const chain = { emit: jest.fn(), to: jest.fn() };
  chain.to.mockReturnValue(chain);
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

describe("createPresenceIndicator", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("broadcasts start, then auto-stops when the TTL expires", async () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
    });

    p.start("room-1");
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:start", false);

    broadcast.mockClear();
    jest.advanceTimersByTime(PRESENCE_TTL_MS);
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:stop", true);
  });

  it("re-arms the window on a repeated start so the TTL never fires early", () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
    });

    p.start("room-1");
    jest.advanceTimersByTime(PRESENCE_TTL_MS - 1000);
    p.start("room-1"); // keystroke refresh
    broadcast.mockClear();

    jest.advanceTimersByTime(PRESENCE_TTL_MS - 1000);
    expect(broadcast).not.toHaveBeenCalledWith(
      "room-1",
      "typing:stop",
      expect.anything()
    );

    jest.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:stop", true);
  });

  it("an explicit stop cancels the TTL — no duplicate stop later", () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
    });

    p.start("room-1");
    p.stop("room-1");
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:stop", false);

    broadcast.mockClear();
    jest.advanceTimersByTime(PRESENCE_TTL_MS * 2);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("flush() stops every pending room exactly once (disconnect cleanup)", () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
    });

    p.start("room-1");
    p.start("room-2");
    broadcast.mockClear();

    p.flush();
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:stop", true);
    expect(broadcast).toHaveBeenCalledWith("room-2", "typing:stop", true);
    expect(broadcast).toHaveBeenCalledTimes(2);

    // Timers were cleared, so nothing fires afterwards.
    broadcast.mockClear();
    jest.advanceTimersByTime(PRESENCE_TTL_MS * 2);
    expect(broadcast).not.toHaveBeenCalled();
  });

  // Settings → Chat → Typing Indicator, off.
  it("suppresses starts when canStart says no — but never the stop", async () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
      canStart: async () => false,
    });

    p.start("room-1");
    await Promise.resolve();
    expect(broadcast).not.toHaveBeenCalled();

    // A stop always goes out, so a switch flipped mid-burst can never strand a
    // peer on a "…is typing" with no stop coming.
    p.stop("room-1");
    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:stop", false);
  });

  it("broadcasts normally when canStart allows it", async () => {
    const broadcast = jest.fn();
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast,
      canStart: async () => true,
    });

    p.start("room-1");
    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledWith("room-1", "typing:start", false);
  });

  it("a throwing broadcast never escapes as an unhandled rejection", () => {
    const p = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast: () => Promise.reject(new Error("roster down")),
    });
    expect(() => p.start("room-1")).not.toThrow();
  });
});

describe("createDirectRosterBroadcast", () => {
  it("delivers to every member except the sender, room-independently", async () => {
    const peerA = { id: "sa", emit: jest.fn() };
    const peerB = { id: "sb", emit: jest.fn() };
    const { ns } = fakeNamespace([peerA, peerB]);

    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "me",
      resolveRoster: async () => ["me", "peer-a", "peer-b"],
      buildPayload: (roomId) => ({ roomId }),
    });

    await broadcast("room-1", "typing:start", false);

    // Sender is never in the resolved recipient rooms.
    expect(ns.in).toHaveBeenCalledWith(["user:peer-a", "user:peer-b"]);
    expect(peerA.emit).toHaveBeenCalledWith("typing:start", {
      roomId: "room-1",
    });
    expect(peerB.emit).toHaveBeenCalledWith("typing:start", {
      roomId: "room-1",
    });
  });

  it("drops the event when the sender is not in the roster (fail-closed gate)", async () => {
    const peer = { id: "sa", emit: jest.fn() };
    const { ns } = fakeNamespace([peer]);

    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "intruder",
      resolveRoster: async () => ["peer-a", "peer-b"],
      buildPayload: () => ({}),
    });

    await broadcast("room-1", "typing:start", false);

    expect(ns.in).not.toHaveBeenCalled();
    expect(peer.emit).not.toHaveBeenCalled();
  });

  it("drops the event when the roster lookup fails (empty roster)", async () => {
    const { ns } = fakeNamespace();
    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "me",
      resolveRoster: async () => [],
      buildPayload: () => ({}),
    });

    await broadcast("room-1", "typing:start", false);
    expect(ns.in).not.toHaveBeenCalled();
  });

  // Settings → Chat → Typing Indicator is reciprocal: a viewer who switched it
  // off is dropped from the RECIPIENT set, not from the roster — dropping them
  // from the roster would read as "sender not a member" and kill the event for
  // everyone else too.
  it("drops recipients the filter rejects, keeping the rest", async () => {
    const peer = { id: "sa", emit: jest.fn() };
    const { ns } = fakeNamespace([peer]);

    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "me",
      resolveRoster: async () => ["me", "peer-a", "peer-b"],
      buildPayload: () => ({}),
      filterRecipients: async (ids) => ids.filter((id) => id !== "peer-b"),
    });

    await broadcast("room-1", "typing:start", false);
    expect(ns.in).toHaveBeenCalledWith(["user:peer-a"]);
  });

  it("emits nothing when every recipient opted out", async () => {
    const { ns } = fakeNamespace();
    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "me",
      resolveRoster: async () => ["me", "peer-a"],
      buildPayload: () => ({}),
      filterRecipients: async () => [],
    });

    await broadcast("room-1", "typing:start", false);
    expect(ns.in).not.toHaveBeenCalled();
  });

  it("honours the cheap pre-gate (closed community) before any lookup", async () => {
    const { ns } = fakeNamespace();
    const resolveRoster = jest.fn();
    const broadcast = createDirectRosterBroadcast({
      namespace: ns,
      senderId: "me",
      resolveRoster,
      buildPayload: () => ({}),
      isSuppressed: () => true,
    });

    await broadcast("room-1", "typing:start", false);
    expect(resolveRoster).not.toHaveBeenCalled();
  });
});

describe("createRoomBroadcast", () => {
  const fakeSocket = () => {
    const chain = { emit: jest.fn(), to: jest.fn() };
    chain.to.mockReturnValue(chain);
    return {
      socket: { to: jest.fn().mockReturnValue(chain) } as unknown as Socket,
      chain,
    };
  };

  it("emits through the sender socket while live (sender excluded)", async () => {
    const { ns } = fakeNamespace();
    const { socket, chain } = fakeSocket();

    const broadcast = createRoomBroadcast({
      namespace: ns,
      socket,
      rooms: (id) => [`conv:${id}`],
      buildPayload: (id) => ({ roomId: id }),
    });

    await broadcast("room-1", "recording:start", false);

    expect(socket.to).toHaveBeenCalledWith("conv:room-1");
    expect(chain.emit).toHaveBeenCalledWith("recording:start", {
      roomId: "room-1",
    });
    expect(ns.to).not.toHaveBeenCalled();
  });

  it("emits namespace-scoped once the TTL fired (socket may be gone)", async () => {
    const { ns, chain } = fakeNamespace();
    const { socket } = fakeSocket();

    const broadcast = createRoomBroadcast({
      namespace: ns,
      socket,
      rooms: (id) => [`community:${id}`, `community-typing:${id}`],
      buildPayload: () => ({}),
    });

    await broadcast("c1", "recording:stop", true);

    expect(ns.to).toHaveBeenCalledWith("community:c1");
    expect(chain.to).toHaveBeenCalledWith("community-typing:c1");
    expect(socket.to).not.toHaveBeenCalled();
  });

  it("drops the event when the authorization gate rejects", async () => {
    const { ns } = fakeNamespace();
    const { socket } = fakeSocket();

    const broadcast = createRoomBroadcast({
      namespace: ns,
      socket,
      rooms: (id) => [`conv:${id}`],
      buildPayload: () => ({}),
      isAuthorized: async () => false,
    });

    await broadcast("room-1", "recording:start", false);
    expect(socket.to).not.toHaveBeenCalled();
    expect(ns.to).not.toHaveBeenCalled();
  });
});

describe("engine + roster wiring (the /chat typing path end to end)", () => {
  // setImmediate stays real so flushAsync() can drain the broadcast's promise
  // chain between timer advances.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["setImmediate"] }));
  afterEach(() => jest.useRealTimers());

  it("auto-stop re-resolves the roster at fire time", async () => {
    const peer = { id: "sa", emit: jest.fn() };
    const { ns } = fakeNamespace([peer]);
    const resolveRoster = jest.fn().mockResolvedValue(["me", "peer-a"]);

    const typing = createPresenceIndicator({
      startEvent: "typing:start",
      stopEvent: "typing:stop",
      broadcast: createDirectRosterBroadcast({
        namespace: ns,
        senderId: "me",
        resolveRoster,
        buildPayload: (roomId) => ({ roomId }),
      }),
    });

    typing.start("room-1");
    await flushAsync();
    expect(resolveRoster).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(PRESENCE_TTL_MS);
    await flushAsync();

    // Second lookup proves membership is re-checked when the timer fires,
    // rather than reusing a roster captured at start time.
    expect(resolveRoster).toHaveBeenCalledTimes(2);
    expect(peer.emit).toHaveBeenCalledWith("typing:stop", {
      roomId: "room-1",
    });
  });
});

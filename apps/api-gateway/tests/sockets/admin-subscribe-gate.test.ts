/**
 * AIM-10 / AIM-15 — the /admin subscribe handlers.
 *
 * Two defects in the same six handlers:
 *
 *  - They validated with `payload?.x?.trim()`, which guards null and undefined
 *    but not a wrong TYPE. `{groupId: 5}` made `(5).trim` undefined and threw
 *    synchronously inside the Socket.IO listener, which does not wrap handlers
 *    in try/catch — and the throw happened BEFORE the permission check, so any
 *    admin token reached it regardless of granted permissions.
 *
 *  - `admin:group:subscribe` accepted any string as a room id and joined
 *    `conv:<id>`. Private DMs publish on that same Redis channel family, so a
 *    `groups.moderate` grant became a live feed of an arbitrary private
 *    conversation — message bodies and attachment URLs included. Private room
 *    ids are not guessable, but they are handed to the panel by the moderation
 *    report pipeline, which makes it a `reports.view` → `groups.moderate`
 *    privilege crossing.
 *
 * These drive the REAL `registerAdminNamespace` rather than a mirrored
 * predicate, because the behaviour under test is what the handler does with a
 * payload — which a re-implementation cannot capture.
 */
import { registerAdminNamespace } from "../../src/sockets/namespaces/admin.ns.js";

jest.mock("../../src/sockets/auth.middleware.js", () => ({
  createGatewayAdminSocketAuthMiddleware: () => () => undefined,
}));

const ADMIN_ID = "admin-1";
const GROUP_ID = `grp_${"a".repeat(16)}`;
const PRIVATE_ROOM_ID = `prv_${"b".repeat(16)}`;
const COMMUNITY_ID = "c".repeat(24);
const STREAM_ID = "d".repeat(24);

type Handler = (...args: unknown[]) => void;

function harness(permissions: string[] = ["groups.moderate"]) {
  const rooms = new Set<string>();
  const handlers = new Map<string, Handler>();

  const socket = {
    id: "socket-1",
    data: { adminId: ADMIN_ID },
    on: (event: string, fn: Handler) => handlers.set(event, fn),
    join: jest.fn(async (room: string) => {
      rooms.add(room);
    }),
    leave: jest.fn(async (room: string) => {
      rooms.delete(room);
    }),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };

  const ns = {
    use: jest.fn(),
    on: jest.fn(),
    adapter: { rooms: new Map() },
    local: { to: () => ({ emit: jest.fn() }) },
    to: () => ({ emit: jest.fn() }),
    in: () => ({ fetchSockets: async () => [] }),
  };

  const redis = {
    // The permission cache backoffice-service populates.
    get: jest.fn(async () => JSON.stringify(permissions)),
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn(),
  };

  registerAdminNamespace(
    { of: () => ns } as never,
    redis as never,
    redis as never
  );

  const onConnection = ns.on.mock.calls.find(
    (c) => c[0] === "connection"
  )![1] as (s: unknown) => void;
  onConnection(socket);
  // Connecting joins `admin:<id>` and `admin:broadcast`; forget those so a
  // "did not join" assertion is about the subscribe under test.
  socket.join.mockClear();

  /** Emit an event and resolve once the handler's async work has settled. */
  const emit = async (event: string, payload: unknown) => {
    const acks: unknown[] = [];
    handlers.get(event)!(payload, (res: unknown) => acks.push(res));
    // The handlers do their permission check in a detached async IIFE.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return acks[0] as { success: boolean; error?: string } | undefined;
  };

  return { emit, rooms, socket };
}

describe("admin:group:subscribe", () => {
  it("joins the conversation room for a real group id", async () => {
    const h = harness();

    const ack = await h.emit("admin:group:subscribe", { groupId: GROUP_ID });

    expect(ack).toEqual({ success: true });
    expect(h.rooms.has(`conv:${GROUP_ID}`)).toBe(true);
  });

  it("refuses a private conversation id, so groups.moderate is not a DM wiretap", async () => {
    const h = harness();

    const ack = await h.emit("admin:group:subscribe", {
      groupId: PRIVATE_ROOM_ID,
    });

    expect(ack).toEqual({ success: false, error: "INVALID_PAYLOAD" });
    expect(h.rooms.has(`conv:${PRIVATE_ROOM_ID}`)).toBe(false);
    expect(h.socket.join).not.toHaveBeenCalled();
  });

  it("refuses an arbitrary unprefixed room id", async () => {
    const h = harness();

    const ack = await h.emit("admin:group:subscribe", {
      groupId: "some-legacy-room-id",
    });

    expect(ack).toEqual({ success: false, error: "INVALID_PAYLOAD" });
    expect(h.socket.join).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", { groupId: 5 }],
    ["an object", { groupId: { toString: () => GROUP_ID } }],
    ["an array", { groupId: [GROUP_ID] }],
    ["a missing field", {}],
    ["null", null],
    ["a bare string", "not-an-object"],
  ])("answers INVALID_PAYLOAD for %s instead of throwing", async (_l, bad) => {
    const h = harness();

    // The assertion is as much that this does not throw: an uncaught throw here
    // reached the process and took the whole gateway down with it.
    const ack = await h.emit("admin:group:subscribe", bad);

    expect(ack).toEqual({ success: false, error: "INVALID_PAYLOAD" });
  });

  it("still enforces the permission for a well-formed id", async () => {
    const h = harness([]); // no groups.moderate

    const ack = await h.emit("admin:group:subscribe", { groupId: GROUP_ID });

    expect(ack).toEqual({ success: false, error: "FORBIDDEN" });
    expect(h.rooms.has(`conv:${GROUP_ID}`)).toBe(false);
  });
});

describe("admin:community:subscribe / admin:stream:subscribe", () => {
  it("joins for a well-formed community id", async () => {
    const h = harness(["communities.moderate"]);

    const ack = await h.emit("admin:community:subscribe", {
      communityId: COMMUNITY_ID,
    });

    expect(ack).toEqual({ success: true });
    expect(h.rooms.has(`community:${COMMUNITY_ID}`)).toBe(true);
  });

  it.each([
    ["a number", { communityId: 5 }],
    ["a non-id string", { communityId: "../conv:prv_abc" }],
    ["a missing field", {}],
  ])("refuses %s on community subscribe", async (_l, bad) => {
    const h = harness(["communities.moderate"]);

    const ack = await h.emit("admin:community:subscribe", bad);

    expect(ack).toEqual({ success: false, error: "INVALID_PAYLOAD" });
    expect(h.socket.join).not.toHaveBeenCalled();
  });

  it("joins for a well-formed stream id and refuses a malformed one", async () => {
    const ok = harness(["livestreams.read"]);
    expect(
      await ok.emit("admin:stream:subscribe", { streamId: STREAM_ID })
    ).toEqual({ success: true });
    expect(ok.rooms.has(`stream:${STREAM_ID}`)).toBe(true);

    const bad = harness(["livestreams.read"]);
    expect(await bad.emit("admin:stream:subscribe", { streamId: 42 })).toEqual({
      success: false,
      error: "INVALID_PAYLOAD",
    });
  });
});

describe("unsubscribe handlers", () => {
  it("leave the room they joined, and ignore malformed payloads quietly", async () => {
    const h = harness();

    await h.emit("admin:group:subscribe", { groupId: GROUP_ID });
    expect(h.rooms.has(`conv:${GROUP_ID}`)).toBe(true);

    // No ack on unsubscribe by contract — the assertion is the room state and
    // that a bad payload does not throw.
    await h.emit("admin:group:unsubscribe", { groupId: 5 });
    expect(h.rooms.has(`conv:${GROUP_ID}`)).toBe(true);

    await h.emit("admin:group:unsubscribe", { groupId: GROUP_ID });
    expect(h.rooms.has(`conv:${GROUP_ID}`)).toBe(false);
  });
});

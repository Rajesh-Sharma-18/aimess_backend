/**
 * `stream:status` ENDED relay — the canonical end event viewers switch servers on.
 *
 * stream-service publishes the ENDED status with the host (`creatorId`), the
 * kind of actor that ended it and its timing. The gateway must hand viewers the
 * HOST as `hostUserId` (never whoever pressed End Live), `endedByType`, and the
 * timestamps; and must keep the LIVE status free of those internal fields.
 */
import { registerStreamNamespace } from "../../src/sockets/namespaces/stream.ns.js";

jest.mock("../../src/sockets/auth.middleware.js", () => ({
  createGatewaySocketAuthMiddleware: () => () => undefined,
}));

function harness() {
  const emitted: { room: string; event: string; data: any }[] = [];
  const direct: { userId: string; event: string; data: any }[] = [];
  let onMessage: (pattern: string, channel: string, msg: string) => void = () => {};
  const hostSocket = {
    data: { userId: "host-1" },
    rooms: new Set<string>(), // the host already left the room
    emit: (event: string, data: unknown) => direct.push({ userId: "host-1", event, data }),
  };
  const ns = {
    use: jest.fn(),
    on: jest.fn(),
    in: () => ({ fetchSockets: async () => [] }),
    to: (room: string) => ({
      emit: (event: string, data: unknown) => emitted.push({ room, event, data }),
    }),
    fetchSockets: async () => [hostSocket],
  };
  const redis = {
    psubscribe: jest.fn(async () => undefined),
    on: jest.fn((event: string, fn: typeof onMessage) => {
      if (event === "pmessage") onMessage = fn;
    }),
  };
  registerStreamNamespace({ of: () => ns } as never, {} as never, redis as never, redis as never, {} as never);
  const publish = (data: Record<string, unknown>) =>
    onMessage("stream:*", `stream:${data.streamId}`, JSON.stringify({ event: "stream:status", data }));
  return { emitted, direct, publish };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("stream:status ENDED relay", () => {
  it.each(["HOST", "COMMUNITY_ADMIN", "SUPER_ADMIN", "SYSTEM"])(
    "ended by %s: viewers get the host, the actor kind and the timing",
    async (endedByType) => {
      const h = harness();
      h.publish({
        streamId: "s1",
        status: "ENDED",
        communityId: "c1",
        creatorId: "host-1",
        endedReason: "X",
        endedByType,
        startedAt: 1000,
        endedAt: 5000,
      });
      await flush();

      const room = h.emitted.find((e) => e.event === "stream:status")!;
      expect(room.room).toBe("stream:s1");
      expect(room.data).toEqual({
        streamId: "s1",
        status: "ENDED",
        communityId: "c1",
        endedReason: "X",
        hostUserId: "host-1",
        endedByType,
        startedAt: 1000,
        endedAt: 5000,
      });
      // A host outside the room still learns their stream ended, same payload.
      expect(h.direct).toEqual([{ userId: "host-1", event: "stream:status", data: room.data }]);
    }
  );

  it("LIVE stays the bare { streamId, status, communityId } shape", async () => {
    const h = harness();
    h.publish({ streamId: "s1", status: "LIVE", communityId: "c1", creatorId: "host-1", startedAt: 1000, hlsUrl: "h" });
    await flush();

    expect(h.emitted.find((e) => e.event === "stream:status")!.data).toEqual({
      streamId: "s1",
      status: "LIVE",
      communityId: "c1",
    });
  });
});

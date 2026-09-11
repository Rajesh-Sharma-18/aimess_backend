/**
 * initiateCall (src/grpc/service-impl.ts createMessagingImpl) — group calling
 * is switched OFF at the gRPC chokepoint.
 *
 * The group ring path was wired end to end — the socket schema accepted
 * `groupId`, `group_id` rode the wire as field 5, and server.ts injected
 * `groupMemberRepo` so `initiateGroupCall` would run — while group calling has
 * no UI and never shipped. Any authenticated user could therefore reach a
 * 255-member roster fan-out that nothing tests and nobody monitors.
 *
 * This pins the guard rather than the schema, because the schema is only the
 * trust boundary: chat-service must refuse `group_id` no matter how the request
 * reached it. Deleting the guard makes this suite fail, which is the point —
 * when group calling is built for real, the four gaps that make it unsafe
 * (membership re-check on answer, end-for-everyone, the busy-gate blind spot,
 * and the uncapped roster) have to be closed in the same change.
 */
import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function invoke(handler: Handler, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

/** Both call paths stubbed, so the test observes WHICH one the handler picked. */
function makeCallService() {
  return {
    initiateCall: jest.fn().mockResolvedValue({
      callId: "c1",
      status: "RINGING",
      livekit: { url: "wss://test.livekit.cloud", token: "tok" },
    }),
    initiateGroupCall: jest.fn().mockResolvedValue({
      callId: "g1",
      status: "RINGING",
      livekit: { url: "wss://test.livekit.cloud", token: "tok" },
    }),
  };
}

describe("initiateCall — group calling is disabled", () => {
  it("rejects a request carrying groupId and never reaches initiateGroupCall", async () => {
    const callService = makeCallService();
    const impl = createMessagingImpl(makeDeps({ callService }));

    await expect(
      invoke(impl.initiateCall as Handler, {
        callerId: "u1",
        groupId: "group-1",
        type: "AUDIO",
      })
    ).rejects.toThrow();

    expect(callService.initiateGroupCall).not.toHaveBeenCalled();
    // Nor may it silently fall through to a 1:1 call with an empty calleeId,
    // which would ring nobody and leave a junk row behind.
    expect(callService.initiateCall).not.toHaveBeenCalled();
  });

  it("rejects groupId even when a calleeId is also supplied", async () => {
    const callService = makeCallService();
    const impl = createMessagingImpl(makeDeps({ callService }));

    await expect(
      invoke(impl.initiateCall as Handler, {
        callerId: "u1",
        calleeId: "u2",
        groupId: "group-1",
        type: "AUDIO",
      })
    ).rejects.toThrow();

    expect(callService.initiateGroupCall).not.toHaveBeenCalled();
    expect(callService.initiateCall).not.toHaveBeenCalled();
  });

  it("still places an ordinary 1:1 call", async () => {
    const callService = makeCallService();
    const impl = createMessagingImpl(makeDeps({ callService }));

    const res = (await invoke(impl.initiateCall as Handler, {
      callerId: "u1",
      calleeId: "u2",
      type: "VIDEO",
      privateRoomId: "room-1",
    })) as { callId: string; livekit: { token: string } };

    expect(callService.initiateGroupCall).not.toHaveBeenCalled();
    expect(callService.initiateCall).toHaveBeenCalledWith({
      callerId: "u1",
      calleeId: "u2",
      type: "VIDEO",
      privateRoomId: "room-1",
    });
    expect(res.callId).toBe("c1");
    expect(res.livekit.token).toBe("tok");
  });
});

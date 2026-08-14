/**
 * `getCommunityMessages` gRPC handler — `pinnedMessageJson` field
 * (service-impl.ts, inside createCommunityImpl). Reuses the existing
 * `CommunityPinService.getActivePinSummary` (no separate pin store/API);
 * this test only verifies the gRPC-layer wiring: the summary is fetched
 * alongside the message page and JSON-serialized onto the response, "" when
 * there is no active pin.
 */
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function invoke(handler: Handler, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

const BASE_REQUEST = {
  roomId: "room_1",
  requesterId: "usr_1",
  cursor: "",
  limit: 30,
};

describe("getCommunityMessages — pinnedMessageJson", () => {
  it("is an empty string when the room has no active pin", async () => {
    const deps = makeDeps({
      communityMessageService: { getMessages: jest.fn().mockResolvedValue([]) },
      communityPinService: {
        getActivePinSummary: jest.fn().mockResolvedValue(null),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await invoke(
      impl.getCommunityMessages as Handler,
      BASE_REQUEST
    );
    expect(res.pinnedMessageJson).toBe("");
  });

  it("carries the JSON-serialized pin summary when a message is pinned", async () => {
    const summary = {
      messageId: "pinned-1",
      roomId: "room_1",
      communityId: "room_1",
      senderId: "usr_2",
      senderName: "Jane",
      senderHandle: "jane",
      senderAvatar: "",
      messageType: "TEXT",
      text: "Meeting at 3pm",
      media: [],
      createdAt: 1751500000000,
      pinnedAt: 1751500100000,
      pinnedBy: "usr_mod",
      isAvailable: true,
    };
    const deps = makeDeps({
      communityMessageService: { getMessages: jest.fn().mockResolvedValue([]) },
      communityPinService: {
        getActivePinSummary: jest.fn().mockResolvedValue(summary),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await invoke(
      impl.getCommunityMessages as Handler,
      BASE_REQUEST
    );
    expect(JSON.parse(res.pinnedMessageJson)).toEqual(summary);
  });

  it("fetches the pin summary for the SAME roomId as the message page (no cross-room leak)", async () => {
    const getActivePinSummary = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({
      communityMessageService: { getMessages: jest.fn().mockResolvedValue([]) },
      communityPinService: { getActivePinSummary },
    });
    const impl = createCommunityImpl(deps);
    await invoke(impl.getCommunityMessages as Handler, {
      ...BASE_REQUEST,
      roomId: "room_42",
    });
    // Viewer-scoped: the requester rides along so a message THEY deleted for
    // themselves is not still served back to them as the pinned message.
    expect(getActivePinSummary).toHaveBeenCalledWith("room_42", "usr_1");
  });
});

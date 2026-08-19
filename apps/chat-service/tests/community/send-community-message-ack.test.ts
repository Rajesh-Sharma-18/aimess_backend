/**
 * ACK payload coverage for the community message send path.
 *
 * The gateway relays the gRPC `SendCommunityMessageResponse` verbatim as the
 * socket ack `data` (see api-gateway ackOk). If the handler fails to copy the
 * created row's id / roomId / createdAt into the response, the FE receives
 * `{ messageId: "", roomId: "", sentAt: 0 }` — a message it can't reconcile,
 * reply to, or mark read. This locks the response contract so the three fields
 * always carry the ACTUAL persisted values (never defaults / hardcodes).
 *
 * Only the service boundary is mocked; the real handler builds the response.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  buildPushPreview: jest.fn(() => "preview text"),
  buildMessagePreview: jest.fn(() => "preview text"),
}));

import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

function invoke(handler: Handler, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

const REQ = {
  communityId: "comm1",
  roomId: "room-abc",
  senderId: "u1",
  clientMessageId: "c1",
  message: "Hello community!",
  contentType: "TEXT",
  mediaKey: "",
  parentMessageId: "",
  attachmentsJson: "",
};

const CREATED_AT = new Date("2026-07-06T10:11:12.000Z");

function makeDepsWithSaved(saved: Record<string, unknown>) {
  return makeDeps({
    cacheRepo: {},
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn(
        async () => new Map([["u1", { displayName: "Alice", avatar: "" }]])
      ),
    },
    communityMessageService: {
      sendMessage: jest.fn(async () => saved),
      getActiveMemberIds: jest.fn(async () => ["u1", "u2"]),
    },
  });
}

describe("sendCommunityMessage — ack payload carries the created message identity", () => {
  it("returns the persisted messageId, roomId and sentAt (epoch ms)", async () => {
    const saved = {
      id: "689f0c3a1b2c3d4e5f607182",
      roomId: "room-abc",
      sentBy: "u1",
      message: "Hello community!",
      messageType: "TEXT",
      parentMessageId: null,
      quoteData: null,
      sequenceNumber: 42,
      createdAt: CREATED_AT,
    };

    const res = (await invoke(
      createCommunityImpl(makeDepsWithSaved(saved))
        .sendCommunityMessage as Handler,
      REQ
    )) as {
      messageId: string;
      roomId: string;
      sentAt: number;
      sequenceNumber: number;
    };

    expect(res).toEqual({
      messageId: "689f0c3a1b2c3d4e5f607182",
      roomId: "room-abc",
      sentAt: CREATED_AT.getTime(),
      sequenceNumber: 42,
    });
    // Never the proto3 defaults the empty-ack bug produced.
    expect(res.messageId).not.toBe("");
    expect(res.roomId).not.toBe("");
    expect(res.sentAt).toBeGreaterThan(0);
    // The ordering key. `sentAt` is the row's createdAt, stamped a round trip
    // AFTER the sequence is allocated, so the two can disagree — without the
    // sequence here the sender can only place its own just-acked row by a
    // timestamp that is not the order the server will serve it back in.
    expect(res.sequenceNumber).toBe(42);
  });

  it("derives roomId from the persisted row, not the request echo", async () => {
    // Row lands in the canonical GeneralRoom whose id === communityId even when
    // the request omitted roomId; the ack must reflect where it was actually
    // stored.
    const saved = {
      id: "msg-2",
      roomId: "comm1",
      sentBy: "u1",
      message: "hi",
      messageType: "TEXT",
      createdAt: CREATED_AT,
    };

    const res = (await invoke(
      createCommunityImpl(makeDepsWithSaved(saved))
        .sendCommunityMessage as Handler,
      { ...REQ, roomId: "comm1" }
    )) as { messageId: string; roomId: string; sentAt: number };

    expect(res.messageId).toBe("msg-2");
    expect(res.roomId).toBe("comm1");
    expect(res.sentAt).toBe(CREATED_AT.getTime());
  });
});

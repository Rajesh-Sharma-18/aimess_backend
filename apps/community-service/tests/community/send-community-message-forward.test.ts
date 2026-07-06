/**
 * community-service `SendCommunityMessage` gRPC handler — the gateway's
 * `community:message:send` entry point.
 *
 * ROOT-CAUSE REGRESSION: this handler used to be a stub returning
 * `{ messageId: "", roomId: "", sentAt: 0 }`, so the socket ack always carried
 * an empty payload. Community message persistence actually lives in chat-service
 * (Mongo store); community-service must FORWARD the send and relay chat-service's
 * real `{ messageId, roomId, sentAt }`.
 *
 * These tests lock that contract:
 *   1. the ack carries the created messageId / roomId / sentAt (never the empty
 *      stub values),
 *   2. the request is forwarded verbatim to chat-service,
 *   3. business/infra gRPC errors propagate (code + details) instead of a fake
 *      empty success — so the gateway can map muted/banned/etc. to a real ack.
 *
 * `getChatClient` is mocked (global-mocks stubs it as a jest.fn); each test
 * injects the chat-service response/behaviour it needs.
 */
import { communityImpl } from "../../src/grpc/community-impl.js";
import { getChatClient } from "../../src/grpc/chat.client.js";

const mockGetChatClient = getChatClient as unknown as jest.Mock;

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function invoke(handler: Handler, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) => (err ? reject(err) : resolve(res)));
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

describe("community-service SendCommunityMessage — forwards to chat-service", () => {
  it("relays the created messageId, roomId and sentAt (never the empty stub)", async () => {
    const send = jest.fn().mockResolvedValue({
      messageId: "689f0c3a1b2c3d4e5f607182",
      roomId: "room-abc",
      sentAt: 1751793072000,
    });
    mockGetChatClient.mockReturnValue({ sendCommunityMessage: send });

    const res = (await invoke(
      communityImpl.sendCommunityMessage as Handler,
      REQ
    )) as { messageId: string; roomId: string; sentAt: number };

    expect(res).toEqual({
      messageId: "689f0c3a1b2c3d4e5f607182",
      roomId: "room-abc",
      sentAt: 1751793072000,
    });
    // The exact regression: none of the three may be the empty-stub value.
    expect(res.messageId).not.toBe("");
    expect(res.roomId).not.toBe("");
    expect(res.sentAt).toBeGreaterThan(0);
  });

  it("forwards every request field verbatim to chat-service", async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ messageId: "m1", roomId: "room-abc", sentAt: 1 });
    mockGetChatClient.mockReturnValue({ sendCommunityMessage: send });

    await invoke(communityImpl.sendCommunityMessage as Handler, {
      ...REQ,
      attachmentsJson: '{"files":[{"objectKey":"k"}]}',
      parentMessageId: "parent-1",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      communityId: "comm1",
      roomId: "room-abc",
      senderId: "u1",
      clientMessageId: "c1",
      message: "Hello community!",
      contentType: "TEXT",
      mediaKey: "",
      parentMessageId: "parent-1",
      attachmentsJson: '{"files":[{"objectKey":"k"}]}',
    });
  });

  it("propagates a chat-service business gRPC error (code + details) unchanged", async () => {
    // e.g. sender is muted → chat-service maps AppError → FAILED_PRECONDITION (9)
    // with the messageKey in `details`. The gateway needs BOTH to surface the
    // specific reason instead of a generic error.
    const send = jest.fn().mockRejectedValue({
      code: 9,
      details: "CHAT_COMMUNITY_MEMBER_MUTED",
      message: "CHAT_COMMUNITY_MEMBER_MUTED",
    });
    mockGetChatClient.mockReturnValue({ sendCommunityMessage: send });

    const err = (await invoke(
      communityImpl.sendCommunityMessage as Handler,
      REQ
    ).catch((e) => e)) as { code: number; details: string };

    expect(err.code).toBe(9);
    expect(err.details).toBe("CHAT_COMMUNITY_MEMBER_MUTED");
  });

  it("collapses an unmapped/infra failure (no gRPC code) to UNAVAILABLE (14)", async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new Error("chat.sendCommunityMessage unavailable"));
    mockGetChatClient.mockReturnValue({ sendCommunityMessage: send });

    const err = (await invoke(
      communityImpl.sendCommunityMessage as Handler,
      REQ
    ).catch((e) => e)) as { code: number };

    expect(err.code).toBe(14); // grpc.status.UNAVAILABLE
  });
});

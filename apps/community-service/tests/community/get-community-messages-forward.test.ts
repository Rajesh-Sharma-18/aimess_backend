/**
 * community-service `GetCommunityMessages` gRPC handler — the gateway's
 * `community:messages:fetch` entry point.
 *
 * ROOT-CAUSE REGRESSION (same bug class as SendCommunityMessage): this handler
 * used to be a stub returning `{ messages: [], nextCursor: "", hasMore: false }`,
 * so socket-based community history fetch always returned an empty page.
 * Community message storage actually lives in chat-service (Mongo store);
 * community-service must FORWARD the read and relay chat-service's real page.
 *
 * These tests lock that contract:
 *   1. the response carries the fetched messages/nextCursor/hasMore/
 *      pinnedMessageJson (never the empty stub values),
 *   2. every DTO field the gateway's socket mapper reads (senderName,
 *      senderAvatar, attachmentsJson, reactionsJson, quoteDataJson, mediaKey,
 *      sentAt) survives the forward — these are exactly the fields that were
 *      missing from the shared proto until this fix,
 *   3. the request is forwarded verbatim to chat-service,
 *   4. a read failure propagates as a real gRPC error (never a silently empty
 *      "page") so the gateway's existing `.catch` → ackError path still fires.
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
  roomId: "room-abc",
  requesterId: "u1",
  cursor: "",
  limit: 30,
};

describe("community-service GetCommunityMessages — forwards to chat-service", () => {
  it("relays the fetched page (never the empty stub values)", async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [
        {
          messageId: "m1",
          roomId: "room-abc",
          senderId: "u2",
          message: "hi there",
          contentType: "TEXT",
          mediaKey: "",
          sentAt: 1751793072000,
          systemMessageType: "",
          systemMetadata: "",
          isPersonal: false,
          senderName: "Alice",
          senderAvatar: "https://cdn.test/avatars/u2.png",
          attachmentsJson: "[]",
          reactionsJson: "[]",
          quoteDataJson: "",
        },
      ],
      nextCursor: "2026-07-06T10:11:12.000Z",
      hasMore: true,
      pinnedMessageJson: '{"messageId":"m0"}',
    });
    mockGetChatClient.mockReturnValue({ getCommunityMessages: getMessages });

    const res = (await invoke(
      communityImpl.getCommunityMessages as Handler,
      REQ
    )) as {
      messages: Array<Record<string, unknown>>;
      nextCursor: string;
      hasMore: boolean;
      pinnedMessageJson: string;
    };

    // Never the empty-stub values.
    expect(res.messages.length).toBeGreaterThan(0);
    expect(res.nextCursor).not.toBe("");
    expect(res.hasMore).toBe(true);
    expect(res.pinnedMessageJson).toBe('{"messageId":"m0"}');

    // Every field the gateway's socket mapper reads must survive the forward —
    // the exact fields the proto was previously missing.
    expect(res.messages[0]).toMatchObject({
      messageId: "m1",
      roomId: "room-abc",
      senderId: "u2",
      message: "hi there",
      contentType: "TEXT",
      senderName: "Alice",
      senderAvatar: "https://cdn.test/avatars/u2.png",
      attachmentsJson: "[]",
      reactionsJson: "[]",
      quoteDataJson: "",
      sentAt: 1751793072000,
    });
  });

  it("forwards the request fields verbatim to chat-service", async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [],
      nextCursor: "",
      hasMore: false,
      pinnedMessageJson: "",
    });
    mockGetChatClient.mockReturnValue({ getCommunityMessages: getMessages });

    await invoke(communityImpl.getCommunityMessages as Handler, {
      ...REQ,
      cursor: "2026-07-05T00:00:00.000Z",
      limit: 15,
    });

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith({
      roomId: "room-abc",
      requesterId: "u1",
      cursor: "2026-07-05T00:00:00.000Z",
      limit: 15,
    });
  });

  it("a genuinely empty history still resolves (not an error)", async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [],
      nextCursor: "",
      hasMore: false,
      pinnedMessageJson: "",
    });
    mockGetChatClient.mockReturnValue({ getCommunityMessages: getMessages });

    const res = (await invoke(
      communityImpl.getCommunityMessages as Handler,
      REQ
    )) as { messages: unknown[]; hasMore: boolean };

    expect(res.messages).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it("propagates a chat-service business gRPC error (code + details) unchanged", async () => {
    const getMessages = jest.fn().mockRejectedValue({
      code: 7, // PERMISSION_DENIED
      details: "CHAT_NOT_A_MEMBER",
      message: "CHAT_NOT_A_MEMBER",
    });
    mockGetChatClient.mockReturnValue({ getCommunityMessages: getMessages });

    const err = (await invoke(
      communityImpl.getCommunityMessages as Handler,
      REQ
    ).catch((e) => e)) as { code: number; details: string };

    expect(err.code).toBe(7);
    expect(err.details).toBe("CHAT_NOT_A_MEMBER");
  });

  it("collapses an unmapped/infra failure (no gRPC code) to UNAVAILABLE (14) — never a fake empty page", async () => {
    const getMessages = jest
      .fn()
      .mockRejectedValue(new Error("chat.getCommunityMessages unavailable"));
    mockGetChatClient.mockReturnValue({ getCommunityMessages: getMessages });

    const err = (await invoke(
      communityImpl.getCommunityMessages as Handler,
      REQ
    ).catch((e) => e)) as { code: number };

    expect(err.code).toBe(14); // grpc.status.UNAVAILABLE
  });
});

/**
 * gRPC (socket) send/edit: `contentJson.mentions` reaches GroupMessageService
 * RAW for GROUP rooms (it resolves them) and is stripped for PRIVATE rooms
 * before any service sees it. The GROUP push carries `mentionedUserIds` from
 * the STORED rows, minus the sender. Room kind comes from the id prefix.
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
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));
jest.mock("../../src/middleware/rate-limit.js", () => ({
  ...jest.requireActual("../../src/middleware/rate-limit.js"),
  assertSendAllowed: jest.fn(async () => undefined),
}));

import * as grpc from "@grpc/grpc-js";
import { BadRequestError, TooManyRequestsError } from "@aimess/errors";

import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { publishMessageSentSafe } from "../../src/events/publish-message-sent.js";
import { assertSendAllowed } from "../../src/middleware/rate-limit.js";

const rateLimitMock = assertSendAllowed as jest.Mock;

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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

const MENTIONS = [{ userId: "u2", username: "bo", offset: 0, length: 3 }];
const contentJson = JSON.stringify({ text: "@bo hi", mentions: MENTIONS });

const sendRequest = (conversationId: string) => ({
  conversationId,
  senderId: "u1",
  receiverId: "u2",
  contentText: "",
  contentType: "TEXT",
  mediaKey: "",
  contentJson,
  repliedToId: "",
  clientMessageId: "c1",
  conversationType: "",
  // Both identity fields supplied → no snapshot lookup (deps stay minimal).
  senderName: "Alice",
  senderAvatar: "avatars/u1/a.png",
  clientTs: 0,
});

const storedRow = (content: unknown) => ({
  id: "m1",
  roomId: "room",
  senderId: "u1",
  messageType: "TEXT",
  content,
  createdAt: new Date(),
  editedAt: new Date(),
  sequenceNumber: 1,
});

describe("gRPC sendMessage — mentions", () => {
  it("GROUP passes raw mentions to the service; push gets stored mentioned ids minus sender", async () => {
    const sendMessage = jest.fn(async () =>
      storedRow({
        text: "@bo hi @me",
        mentions: [
          ...MENTIONS,
          { userId: "u1", username: "me", offset: 7, length: 3 },
        ],
      })
    );
    const deps = {
      groupMessageService: {
        sendMessage,
        getActiveMemberIds: jest.fn(async () => ["u1", "u2"]),
      },
    } as unknown as GrpcDeps;

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      sendRequest("grp_room")
    );
    await flush();

    expect(
      (
        sendMessage.mock.calls[0] as unknown as [
          { content: { mentions: unknown } },
        ]
      )[0].content.mentions
    ).toEqual(MENTIONS);
    expect(publishMessageSentSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationType: "GROUP",
        mentionedUserIds: ["u2"],
      })
    );
  });

  it("PRIVATE strips mentions before the service and the push", async () => {
    const sendMessage = jest.fn(async () => storedRow({ text: "@bo hi" }));
    const deps = {
      privateMessageService: { sendMessage },
    } as unknown as GrpcDeps;

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      sendRequest("prv_room")
    );
    await flush();

    const content = (
      sendMessage.mock.calls[0] as unknown as [{ content: object }]
    )[0].content;
    expect(content).not.toHaveProperty("mentions");
    expect(
      (publishMessageSentSafe as jest.Mock).mock.calls[0]?.[0]
    ).not.toHaveProperty("mentionedUserIds");
  });
});

describe("gRPC editMessage — mentions", () => {
  const editRequest = (conversationId: string) => ({
    messageId: "m1",
    conversationId,
    editorId: "u1",
    contentJson,
  });

  it("GROUP passes raw mentions to the service and charges the gm:send bucket", async () => {
    const editMessage = jest.fn(async () => storedRow({ text: "@bo hi" }));
    const deps = {
      groupMessageService: { editMessage },
    } as unknown as GrpcDeps;

    await invoke(
      createMessagingImpl(deps).editMessage as Handler,
      editRequest("grp_room")
    );

    expect(
      (
        editMessage.mock.calls[0] as unknown as [
          { content: { mentions: unknown } },
        ]
      )[0].content.mentions
    ).toEqual(MENTIONS);
    expect(rateLimitMock).toHaveBeenCalledWith("gm", "u1");
  });

  it("PRIVATE strips mentions and is not charged", async () => {
    const editMessage = jest.fn(async () => storedRow({ text: "@bo hi" }));
    const deps = {
      privateMessageService: { editMessage },
    } as unknown as GrpcDeps;

    await invoke(
      createMessagingImpl(deps).editMessage as Handler,
      editRequest("prv_room")
    );

    expect(
      (editMessage.mock.calls[0] as unknown as [{ content: object }])[0].content
    ).not.toHaveProperty("mentions");
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  const rawError = (handler: Handler, request: unknown): Promise<unknown> =>
    new Promise((resolve) => handler({ request }, (err) => resolve(err)));

  it("a GROUP edit over the limit is refused exactly like a send", async () => {
    const editMessage = jest.fn();
    const sendMessage = jest.fn();
    const impl = createMessagingImpl({
      groupMessageService: { editMessage, sendMessage },
    } as unknown as GrpcDeps);

    rateLimitMock.mockRejectedValueOnce(
      new TooManyRequestsError("RATE_LIMITED", 7)
    );
    const editErr = await rawError(
      impl.editMessage as Handler,
      editRequest("grp_room")
    );
    rateLimitMock.mockRejectedValueOnce(
      new TooManyRequestsError("RATE_LIMITED", 7)
    );
    const sendErr = await rawError(
      impl.sendMessage as Handler,
      sendRequest("grp_room")
    );

    expect(editErr).toEqual({
      code: grpc.status.RESOURCE_EXHAUSTED,
      message: "RATE_LIMITED",
    });
    expect(editErr).toEqual(sendErr);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("any other edit error keeps the INTERNAL mapping", async () => {
    const impl = createMessagingImpl({
      groupMessageService: {
        editMessage: jest.fn(async () => {
          throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
        }),
      },
    } as unknown as GrpcDeps);

    const err = await rawError(
      impl.editMessage as Handler,
      editRequest("grp_room")
    );

    expect(err).toMatchObject({ code: grpc.status.INTERNAL });
  });
});

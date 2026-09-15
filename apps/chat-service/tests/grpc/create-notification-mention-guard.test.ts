/**
 * CreateNotification decides a `chat.mention` row late: a NEW row is written
 * only while the group message still exists and still mentions the recipient,
 * individually or through @all, whichever kind the row was written for — the
 * edit retraction's rule. A lookup failure fails open.
 * `redis.publish` is the global jest.fn from tests/setup/global-mocks.ts.
 */
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  publishMentionRetractedSafe: jest.fn(),
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));

import {
  createNotificationImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

const RECIPIENT = "u_kristi";
const text = "@kristi and @all";
const USER_ENTITY = {
  type: "USER",
  userId: RECIPIENT,
  username: "kristi",
  offset: 0,
  length: 7,
};
const ALL_ENTITY = { type: "ALL", offset: 12, length: 4 };

function setup(findMessageById: jest.Mock) {
  const notificationRepo = {
    create: jest.fn(async (input: Record<string, unknown>) => ({
      id: "notif-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    })),
    getUnreadCount: jest.fn(async () => 1),
    findActiveByGroupKey: jest.fn(async () => null),
  };
  const deps = {
    notificationRepo,
    groupMessageService: { findMessageById },
  } as unknown as GrpcDeps;
  const handler = createNotificationImpl(deps).createNotification as Handler;
  const send = (data: Record<string, string>) =>
    new Promise<{ id: string }>((resolve, reject) =>
      handler(
        {
          request: {
            userId: RECIPIENT,
            actorId: "u_sender",
            type: "chat.mention",
            title: "",
            body: "Me mentioned you",
            data: {
              groupKey: "mention:m1",
              conversationId: "grp_1",
              conversationType: "GROUP",
              messageId: "m1",
              ...data,
            },
          },
        },
        (err, res) =>
          err ? reject(err as Error) : resolve(res as { id: string })
      )
    );
  return { notificationRepo, send };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  roomId: "grp_1",
  isDeleted: false,
  content: { text, mentions: [USER_ENTITY, ALL_ENTITY] },
  ...over,
});

describe("CreateNotification — chat.mention write-time guard", () => {
  it("creates the row while the USER mention still stands", async () => {
    const { notificationRepo, send } = setup(jest.fn(async () => message()));
    await expect(send({ mentionType: "USER" })).resolves.toEqual({
      id: "notif-1",
    });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
  });

  it("skips a message deleted for everyone", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () => message({ isDeleted: true }))
    );
    await expect(send({ mentionType: "USER" })).resolves.toEqual({ id: "" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("skips a missing message", async () => {
    const { notificationRepo, send } = setup(jest.fn(async () => null));
    await expect(send({ mentionType: "USER" })).resolves.toEqual({ id: "" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("skips a USER row whose mention was edited away", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () => message({ content: { text: "hello" } }))
    );
    await expect(send({ mentionType: "USER" })).resolves.toEqual({ id: "" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("keeps a USER row whose mention was removed while @all stayed (same as the edit retraction)", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () =>
        message({ content: { text: "@all", mentions: [ALL_ENTITY] } })
      )
    );
    await send({ mentionType: "USER" });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
  });

  it("creates an ALL row while @all is still present", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () =>
        message({ content: { text: "@all", mentions: [ALL_ENTITY] } })
      )
    );
    await send({ mentionType: "ALL" });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
  });

  it("keeps an ALL row when @all was swapped for a USER mention of the recipient", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () =>
        message({ content: { text: "@kristi", mentions: [USER_ENTITY] } })
      )
    );
    await send({ mentionType: "ALL" });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
  });

  it("skips an ALL row once @all was removed and the recipient is not named", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () =>
        message({
          content: {
            text: "@bob",
            mentions: [{ ...USER_ENTITY, userId: "u_bob", username: "bob" }],
          },
        })
      )
    );
    await expect(send({ mentionType: "ALL" })).resolves.toEqual({ id: "" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it("fails open when the lookup throws", async () => {
    const { notificationRepo, send } = setup(
      jest.fn(async () => {
        throw new Error("mongo down");
      })
    );
    await send({ mentionType: "USER" });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
  });

  it("re-checks after the insert: a retraction inside the window soft-deletes the row, no notification:new", async () => {
    const findMessageById = jest
      .fn()
      .mockResolvedValueOnce(message())
      .mockResolvedValueOnce(message({ isDeleted: true }));
    const { notificationRepo, send } = setup(findMessageById);
    const deleteActiveByGroupKey = jest.fn(async () => ({ ids: ["notif-1"] }));
    Object.assign(notificationRepo, { deleteActiveByGroupKey });

    await expect(send({ mentionType: "USER" })).resolves.toEqual({ id: "" });
    expect(notificationRepo.create).toHaveBeenCalledTimes(1);
    expect(deleteActiveByGroupKey).toHaveBeenCalledWith(
      RECIPIENT,
      "mention:m1"
    );
    // publishRow reads the unread count first — never reached.
    expect(notificationRepo.getUnreadCount).not.toHaveBeenCalled();
    expect(findMessageById).toHaveBeenCalledTimes(2);
  });

  it("an existing row (redelivery) is updated without a lookup", async () => {
    const findMessageById = jest.fn(async () => null);
    const { notificationRepo, send } = setup(findMessageById);
    const applyStateTransition = jest.fn(async () => ({
      id: "notif-old",
      type: "chat.mention",
      createdAt: new Date(),
      updatedAt: new Date(),
      payload: {},
    }));
    Object.assign(notificationRepo, {
      findActiveByGroupKey: jest.fn(async () => ({
        id: "notif-old",
        type: "chat.mention",
        payload: { data: {} },
      })),
      applyStateTransition,
    });
    await expect(send({ mentionType: "USER" })).resolves.toEqual({
      id: "notif-old",
    });
    expect(findMessageById).not.toHaveBeenCalled();
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });
});

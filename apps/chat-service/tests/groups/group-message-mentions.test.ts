/**
 * Group @mentions through the REAL REST routes → orchestrator → GroupMessageService
 * (app-factory harness, mock repos). The resolver's own rules are unit-covered in
 * tests/lib/group-mentions.test.ts; this suite pins the WIRING: what gets
 * persisted on send/edit/forward, what the push publisher is told, and that the
 * private path never persists mentions.
 *
 * The push publisher is mocked so assertions read its params directly.
 */
jest.mock("../../src/events/publish-message-sent.js", () => ({
  ...jest.requireActual("../../src/events/publish-message-sent.js"),
  publishMessageSentSafe: jest.fn(),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { publishMessageSentSafe } from "../../src/events/publish-message-sent.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";

const pushMock = publishMessageSentSafe as jest.Mock;

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const TARGET = "grp_target";
const SEND_URL = `/api/chat/groups/rooms/${ROOM}/messages`;
const EDIT_URL = "/api/chat/groups/messages/g1";

const HANDLES: Record<string, string> = { u_kristi: "kristi", u_bob: "bob" };
const ACTIVE = new Set([TEST_USER_ID, "u_kristi", "u_bob"]);

const at = (userId: string, text: string, token: string) => ({
  userId,
  username: token.slice(1),
  offset: text.indexOf(token),
  length: token.length,
});
const stored = (userId: string, text: string, token: string) => ({
  ...at(userId, text, token),
  username: HANDLES[userId],
});

const createdContents = (): Array<Record<string, unknown>> =>
  mocks.groupMessageRepo.create.mock.calls.map(
    (c: unknown[]) => (c[0] as { content: Record<string, unknown> }).content
  );

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockImplementation(
    async () =>
      new Map(
        Object.entries(HANDLES).map(([userId, memberId]) => [
          userId,
          { userId, memberId, isDeletedUser: false },
        ])
      )
  );
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "ACTIVE",
    role: "MEMBER",
  });
  mocks.groupMemberRepo.findActiveUserIds.mockImplementation(
    async (_roomId: string, ids: string[]) => ids.filter((id) => ACTIVE.has(id))
  );
  mocks.groupMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.groupMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue([]);
  let n = 0;
  mocks.groupMessageRepo.create.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `gmsg_${++n}`,
      createdAt: new Date(1000 + n),
    })
  );
});

describe("send", () => {
  it("persists only resolved mentions and tells the push who was mentioned", async () => {
    const text = "hey @kristi and @ghost";
    const res = await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "TEXT",
        content: {
          text,
          mentions: [
            at("u_kristi", text, "@kristi"),
            at("u_ghost", text, "@ghost"),
          ],
        },
        clientMessageId: "cmid-mention-1",
      });

    expect(res.status).toBe(201);
    expect(createdContents()[0]!.mentions).toEqual([
      stored("u_kristi", text, "@kristi"),
    ]);
    expect(res.body.data.content.mentions).toEqual([
      stored("u_kristi", text, "@kristi"),
    ]);
    await flush();
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationType: "GROUP",
        mentionedUserIds: ["u_kristi"],
      })
    );
  });

  it("no mentions (or none valid) → no mentions key on the stored content", async () => {
    await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({ messageType: "TEXT", content: { text: "plain" } })
      .expect(201);
    await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "TEXT",
        content: {
          text: "a@kristi",
          mentions: [{ userId: "u_kristi", offset: 1, length: 7 }],
        },
      })
      .expect(201);

    for (const content of createdContents()) {
      expect(content).not.toHaveProperty("mentions");
    }
  });

  it("album keeps mentions on row 0 (the caption) only", async () => {
    const text = "look @kristi";
    const file = (name: string) => ({
      objectKey: `chat-uploads/${TEST_USER_ID}/${name}`,
      mime: "image/jpeg",
      size: 1000,
    });
    const res = await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "IMAGE",
        content: {
          text,
          files: [file("a.jpg"), file("b.jpg")],
          mentions: [at("u_kristi", text, "@kristi")],
        },
        clientMessageId: "cmid-album-mention",
      });

    expect(res.status).toBe(201);
    const [first, second] = createdContents();
    expect(first!.mentions).toEqual([stored("u_kristi", text, "@kristi")]);
    expect(second).not.toHaveProperty("mentions");
    expect(second!.text).toBe("");
  });

  it("more than 50 mentions → 400 CHAT_MENTION_LIMIT_EXCEEDED, nothing stored", async () => {
    const res = await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "TEXT",
        content: {
          text: "@kristi",
          mentions: Array.from({ length: 51 }, () => ({
            userId: "u_kristi",
            offset: 0,
            length: 7,
          })),
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHAT_MENTION_LIMIT_EXCEEDED");
    expect(mocks.groupMessageRepo.create).not.toHaveBeenCalled();
  });

  it("idempotent replay returns the stored row without re-resolving or pushing", async () => {
    mocks.groupMessageRepo.findByClientMessageId.mockResolvedValue({
      id: "existing",
      roomId: ROOM,
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      content: { text: "hey @kristi" },
      sequenceNumber: 3,
      createdAt: new Date(1),
    });
    const text = "hey @kristi";
    const res = await request(app)
      .post(SEND_URL)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "TEXT",
        content: { text, mentions: [at("u_kristi", text, "@kristi")] },
        clientMessageId: "cmid-replay",
      });

    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.findActiveUserIds).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.create).not.toHaveBeenCalled();
    await flush();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("PRIVATE REST send never persists or pushes mentions", async () => {
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
    mocks.privateMessageRepo.createMessage.mockResolvedValue({
      id: "pm1",
      messageType: "TEXT",
      content: { text: "hi @kristi" },
      sequenceNumber: 1,
      createdAt: new Date(1),
    });
    const text = "hi @kristi";
    const res = await request(app)
      .post("/api/chat/private/rooms/prv_room/messages")
      .set(bearer(makeAccessToken()))
      .send({
        content: { text, mentions: [at("u_kristi", text, "@kristi")] },
        messageType: "TEXT",
      });

    expect(res.status).toBe(201);
    expect(
      JSON.stringify(mocks.privateMessageRepo.createMessage.mock.calls)
    ).not.toContain("mentions");
    await flush();
    expect(pushMock.mock.calls[0]?.[0]).not.toHaveProperty("mentionedUserIds");
  });
});

describe("edit", () => {
  const row = (content: Record<string, unknown>) => ({
    id: "g1",
    roomId: ROOM,
    senderId: TEST_USER_ID,
    senderName: "Me",
    senderAvatar: "",
    clientMessageId: "c-g1",
    messageType: "TEXT",
    isDeleted: false,
    createdAt: new Date(Date.now() - 1000),
    content,
  });
  const editedContent = () =>
    mocks.groupMessageRepo.editMessage.mock.calls[0]![2] as Record<
      string,
      unknown
    >;

  beforeEach(() => {
    mocks.groupMessageRepo.editMessage.mockImplementation(
      async (
        _id: string,
        _roomId: string,
        content: Record<string, unknown>
      ) => ({
        ...row(content),
        editedAt: new Date(),
      })
    );
  });

  it("adding a mention pushes ONLY the newly mentioned user", async () => {
    const before = "hi @kristi";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text: before, mentions: [stored("u_kristi", before, "@kristi")] })
    );
    const text = "hi @kristi and @bob";
    const res = await request(app)
      .patch(EDIT_URL)
      .set(bearer(makeAccessToken()))
      .send({
        content: {
          text,
          mentions: [
            at("u_kristi", text, "@kristi"),
            at("u_bob", text, "@bob"),
          ],
        },
      });

    expect(res.status).toBe(200);
    expect(editedContent()).toEqual({
      text,
      urls: [],
      mentions: [
        stored("u_kristi", text, "@kristi"),
        stored("u_bob", text, "@bob"),
      ],
    });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: ROOM,
        conversationType: "GROUP",
        messageId: "g1",
        clientMessageId: "c-g1",
        senderId: TEST_USER_ID,
        messageType: "TEXT",
        recipientIds: ["u_bob"],
        mentionedUserIds: ["u_bob"],
      })
    );
  });

  it("keeping the same mentions pushes nothing", async () => {
    const text = "hi @kristi";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text, mentions: [stored("u_kristi", text, "@kristi")] })
    );
    await request(app)
      .patch(EDIT_URL)
      .set(bearer(makeAccessToken()))
      .send({ content: { text, mentions: [at("u_kristi", text, "@kristi")] } })
      .expect(200);

    expect(editedContent().mentions).toEqual([
      stored("u_kristi", text, "@kristi"),
    ]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("removing a mention leaves no stale entity and pushes nothing", async () => {
    const before = "hi @kristi";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text: before, mentions: [stored("u_kristi", before, "@kristi")] })
    );
    await request(app)
      .patch(EDIT_URL)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hi all", mentions: [] } })
      .expect(200);

    expect(editedContent()).toEqual({ text: "hi all", urls: [] });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("omitting mentions keeps previous ones still valid for the new text", async () => {
    const before = "hi @kristi and @bob";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({
        text: before,
        mentions: [
          stored("u_kristi", before, "@kristi"),
          stored("u_bob", before, "@bob"),
        ],
      })
    );
    // @kristi unchanged; the token at bob's offset was rewritten to @rob.
    const text = "hi @kristi and @rob";
    await request(app)
      .patch(EDIT_URL)
      .set(bearer(makeAccessToken()))
      .send({ content: { text } })
      .expect(200);

    expect(editedContent().mentions).toEqual([
      stored("u_kristi", text, "@kristi"),
    ]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("omitting mentions drops a previous mention whose token moved", async () => {
    const before = "hi @kristi";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text: before, mentions: [stored("u_kristi", before, "@kristi")] })
    );
    await request(app)
      .patch(EDIT_URL)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hey @kristi" } })
      .expect(200);

    expect(editedContent()).not.toHaveProperty("mentions");
  });

  describe("lookup outage on an edit that omits mentions", () => {
    const before = "hi @kristi teh";
    const text = "hi @kristi the";
    beforeEach(() => {
      mocks.groupMessageRepo.findById.mockResolvedValue(
        row({ text: before, mentions: [stored("u_kristi", before, "@kristi")] })
      );
    });
    const editTextOnly = () =>
      request(app)
        .patch(EDIT_URL)
        .set(bearer(makeAccessToken()))
        .send({ content: { text } })
        .expect(200);

    it("roster query rejects → previous mentions kept, nothing published", async () => {
      mocks.groupMemberRepo.findActiveUserIds.mockRejectedValue(
        new Error("pool exhausted")
      );
      await editTextOnly();

      expect(editedContent().mentions).toEqual([
        stored("u_kristi", text, "@kristi"),
      ]);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("placeholder snapshot (memberId '') → previous mentions kept", async () => {
      mocks.cacheRepo.getUserSnapshots.mockImplementation(
        async () =>
          new Map([
            [
              "u_kristi",
              { userId: "u_kristi", memberId: "", isDeletedUser: false },
            ],
          ])
      );
      await editTextOnly();

      expect(editedContent().mentions).toEqual([
        stored("u_kristi", text, "@kristi"),
      ]);
    });

    it("a known-inactive member is still dropped", async () => {
      mocks.groupMemberRepo.findActiveUserIds.mockResolvedValue([]);
      await editTextOnly();

      expect(editedContent()).not.toHaveProperty("mentions");
    });
  });

  describe("mention notifications are claimed once per user per message", () => {
    // SET NX semantics over pipeline().set().exec(), the only Redis surface
    // the claim uses.
    function claimRedis() {
      const claimed = new Set<string>();
      const keys: string[] = [];
      return {
        keys,
        pipeline: jest.fn(() => {
          const queued: string[] = [];
          const p = {
            set: jest.fn((key: string) => {
              queued.push(key);
              return p;
            }),
            exec: jest.fn(async () =>
              queued.map((key) => {
                keys.push(key);
                if (claimed.has(key)) return [null, null];
                claimed.add(key);
                return [null, "OK"];
              })
            ),
          };
          return p;
        }),
      };
    }

    let redis: ReturnType<typeof claimRedis>;
    let service: GroupMessageService;
    beforeEach(() => {
      redis = claimRedis();
      service = new GroupMessageService(
        mocks.groupMessageRepo,
        mocks.groupRoomRepo,
        mocks.groupMemberRepo,
        mocks.cacheRepo,
        mocks.userSnapshotService,
        undefined,
        redis as never
      );
    });
    const edit = (text: string, mentions: unknown[]) =>
      service.editMessage({
        messageId: "g1",
        userId: TEST_USER_ID,
        content: { text, mentions },
      });

    it("send claims its mentions, so a later edit re-adding them pushes nothing", async () => {
      mocks.groupMessageRepo.create.mockImplementation(
        async (entity: Record<string, unknown>) => ({
          ...entity,
          id: "g1",
          createdAt: new Date(),
        })
      );
      const sent = "hi @kristi";
      await service.sendMessage({
        roomId: ROOM,
        senderId: TEST_USER_ID,
        senderName: "Me",
        senderAvatar: "",
        content: { text: sent, mentions: [at("u_kristi", sent, "@kristi")] },
        messageType: "TEXT",
        clientMessageId: "c-claim",
      });
      expect(redis.keys).toEqual(["gm:mention-notified:{g1}:u_kristi"]);

      // An earlier edit removed the mention; this one restores it.
      mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "hi" }));
      await edit(sent, [at("u_kristi", sent, "@kristi")]);

      expect(pushMock).not.toHaveBeenCalled();
    });

    it("toggling a mention off and on pushes once; a genuinely new user still pushes", async () => {
      const on = "hi @kristi";
      mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "hi" }));
      await edit(on, [at("u_kristi", on, "@kristi")]);

      mocks.groupMessageRepo.findById.mockResolvedValue(
        row({ text: on, mentions: [stored("u_kristi", on, "@kristi")] })
      );
      await edit("hi", []);

      const both = "hi @kristi @bob";
      mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "hi" }));
      await edit(both, [
        at("u_kristi", both, "@kristi"),
        at("u_bob", both, "@bob"),
      ]);

      expect(pushMock).toHaveBeenCalledTimes(2);
      expect(pushMock.mock.calls[0]![0]).toMatchObject({
        recipientIds: ["u_kristi"],
        mentionedUserIds: ["u_kristi"],
      });
      expect(pushMock.mock.calls[1]![0]).toMatchObject({
        recipientIds: ["u_bob"],
        mentionedUserIds: ["u_bob"],
      });
    });

    it("a per-command Redis error fails open (the mention still pushes)", async () => {
      const failing = {
        pipeline: () => {
          const p = {
            set: () => p,
            exec: async () => [[new Error("OOM"), null]],
          };
          return p;
        },
      };
      service = new GroupMessageService(
        mocks.groupMessageRepo,
        mocks.groupRoomRepo,
        mocks.groupMemberRepo,
        mocks.cacheRepo,
        mocks.userSnapshotService,
        undefined,
        failing as never
      );
      const on = "hi @kristi";
      mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "hi" }));
      await edit(on, [at("u_kristi", on, "@kristi")]);

      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({ mentionedUserIds: ["u_kristi"] })
      );
    });
  });

  it("an edit never persists files (socket/gRPC content is parsed wholesale)", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "old" }));
    await mocks.groupMessageService.editMessage({
      messageId: "g1",
      userId: TEST_USER_ID,
      content: {
        text: "new",
        files: [{ objectKey: "chat-uploads/someone-else/secret.jpg" }],
      },
    });

    expect(editedContent()).toEqual({ text: "new", urls: [] });
  });
});

describe("forward", () => {
  it("keeps only mentions of users active in the TARGET room and publishes no push", async () => {
    const text = "hi @kristi @bob";
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: ROOM,
      senderId: "u_bob",
      isDeleted: false,
      messageType: "TEXT",
      content: {
        text,
        mentions: [
          stored("u_kristi", text, "@kristi"),
          stored("u_bob", text, "@bob"),
        ],
      },
      createdAt: new Date(1),
    });
    mocks.groupMemberRepo.findActiveUserIds.mockImplementation(
      async (roomId: string, ids: string[]) =>
        roomId === TARGET ? ids.filter((id) => id === "u_bob") : ids
    );
    mocks.groupMessageRepo.createForwardedMessage.mockImplementation(
      async (data: Record<string, unknown>) => ({
        ...data,
        id: "fwd1",
        createdAt: new Date(2),
      })
    );

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: TARGET });

    expect(res.status).toBe(201);
    expect(mocks.groupMemberRepo.findActiveUserIds).toHaveBeenCalledWith(
      TARGET,
      expect.any(Array)
    );
    const forwarded = mocks.groupMessageRepo.createForwardedMessage.mock
      .calls[0]![0] as { content: Record<string, unknown> };
    expect(forwarded.content.mentions).toEqual([stored("u_bob", text, "@bob")]);
    await flush();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

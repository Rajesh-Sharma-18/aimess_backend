/**
 * Broadcast-wiring coverage for the gRPC service implementations
 * (src/grpc/service-impl.ts). The resolver itself (src/lib/media-resolve) is
 * unit-covered by tests/lib/media-resolve.test.ts; THIS suite closes the
 * integration gap: that every realtime broadcast actually runs its stored
 * object-keys through the resolver before `redis.publish(...)`, so the wire
 * payload carries full presigned URLs (`https://media.test/<bucket>/<key>`) and
 * never a raw object key. http(s) values must pass through untouched.
 *
 * Infra-free: the resolver is driven by the global `config/storage.js`
 * mediaUrlStrategy mock (tests/setup/global-mocks.ts) → `https://media.test/...`;
 * `redis.publish` is the global jest.fn from that same setup. The fire-and-forget
 * side-channels (bump / push / activity publishers) are mocked to no-ops so the
 * only `redis.publish` calls observed are the broadcasts under test — and so the
 * test never reaches a real RabbitMQ (RABBITMQ_URL is set in the test env).
 *
 * Bucket names come from the test env defaults (tests/setup/env.ts +
 * config/env.ts): avatars→aimess-avatars, community→aimess-community,
 * chat (and any unrecognized prefix, incl. *-chat-uploads)→aimess-chat-test.
 */

// --- Side-channel publishers: no-op so they neither hit RabbitMQ nor pollute
//     the redis.publish call log we assert on. buildPushPreview/buildMessagePreview
//     are pure helpers the impl also imports; stub them (unused by the broadcasts).
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

import {
  createMessagingImpl,
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { redis } from "../../src/config/redis.js";
import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";

const AVATARS = "aimess-avatars";
const CHAT = "aimess-chat-test";
const url = (bucket: string, key: string) =>
  `https://media.test/${bucket}/${key}`;

const publishMock = redis.publish as jest.Mock;

/** Build a partial GrpcDeps; each handler only touches the services it needs. */
function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

/** Invoke a unary handler and resolve with its callback response (or reject on
 *  error). Every broadcast `await redis.publish(...)`s before calling back, so by
 *  resolution the published payload is already recorded. */
function invoke(handler: Handler, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

/** Find the single redis.publish whose envelope `event` matches; parse its data. */
function published(event: string): { channel: string; data: any } {
  const calls = publishMock.mock.calls as Array<[string, string]>;
  for (const [channel, json] of calls) {
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (parsed?.event === event) return { channel, data: parsed.data };
  }
  const seen = calls
    .map((c) => {
      try {
        return JSON.parse(c[1]).event;
      } catch {
        return "<unparseable>";
      }
    })
    .join(", ");
  throw new Error(`no redis.publish for event "${event}". seen: [${seen}]`);
}

describe("createMessagingImpl — broadcast media resolve-on-read", () => {
  it("sendMessage (PRIVATE) → message:new resolves sender avatar + content.files[] URLs", async () => {
    const deps = makeDeps({
      privateMessageService: {
        sendMessage: jest.fn(async () => ({
          id: "m1",
          messageType: "IMAGE",
          content: {
            text: "hi",
            files: [{ objectKey: "chat-uploads/u1/a.jpg", name: "a.jpg" }],
          },
          createdAt: new Date(),
          sequenceNumber: 7,
          senderRole: "MEMBER",
        })),
      },
    });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, {
      conversationId: "conv1",
      senderId: "u1",
      receiverId: "u2",
      contentText: "hi",
      contentType: "IMAGE",
      mediaKey: "",
      contentJson: "",
      repliedToId: "",
      clientMessageId: "c1",
      conversationType: "PRIVATE",
      senderName: "Alice",
      senderAvatar: "avatars/u1/a.png", // raw object key
      clientTs: 0,
    });

    const { channel, data } = published("message:new");
    expect(channel).toBe("conv:conv1");
    expect(data.senderAvatar).toBe(url(AVATARS, "avatars/u1/a.png"));
    expect(data.content.files[0].url).toBe(url(CHAT, "chat-uploads/u1/a.jpg"));
    // objectKey is preserved alongside the resolved url (wire keeps both)
    expect(data.content.files[0].objectKey).toBe("chat-uploads/u1/a.jpg");
  });

  it("sendMessage (PRIVATE) → passes full http(s) avatar + file url through unchanged", async () => {
    const deps = makeDeps({
      privateMessageService: {
        sendMessage: jest.fn(async () => ({
          id: "m2",
          messageType: "IMAGE",
          content: {
            text: "",
            files: [{ url: "https://cdn.example.com/legacy.png" }],
          },
          createdAt: new Date(),
          sequenceNumber: 8,
        })),
      },
    });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, {
      conversationId: "conv1",
      senderId: "u1",
      receiverId: "u2",
      contentText: "",
      contentType: "IMAGE",
      mediaKey: "",
      contentJson: "",
      repliedToId: "",
      clientMessageId: "c2",
      conversationType: "PRIVATE",
      senderName: "Alice",
      senderAvatar: "https://cdn.example.com/me.png", // already a URL
      clientTs: 0,
    });

    const { data } = published("message:new");
    expect(data.senderAvatar).toBe("https://cdn.example.com/me.png");
    expect(data.content.files[0].url).toBe(
      "https://cdn.example.com/legacy.png"
    );
  });

  it("sendMessage (GROUP) → message:new resolves avatar + files via the GROUP branch", async () => {
    const deps = makeDeps({
      groupMessageService: {
        sendMessage: jest.fn(async () => ({
          id: "gm1",
          messageType: "IMAGE",
          content: {
            text: "team",
            files: [
              { objectKey: "group-chat-uploads/g1/a.jpg", name: "a.jpg" },
            ],
          },
          createdAt: new Date(),
          sequenceNumber: 3,
          senderRole: "ADMIN",
        })),
      },
    });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, {
      conversationId: "room9",
      senderId: "u1",
      receiverId: "",
      contentText: "team",
      contentType: "IMAGE",
      mediaKey: "",
      contentJson: "",
      repliedToId: "",
      clientMessageId: "g1",
      conversationType: "GROUP",
      senderName: "Alice",
      senderAvatar: "avatars/u1/a.png",
      clientTs: 0,
    });

    const { channel, data } = published("message:new");
    expect(channel).toBe("conv:room9");
    expect(data.conversationType).toBe("GROUP");
    expect(data.receiverId).toBe(""); // GROUP omits receiverId
    expect(data.senderAvatar).toBe(url(AVATARS, "avatars/u1/a.png"));
    expect(data.content.files[0].url).toBe(
      url(CHAT, "group-chat-uploads/g1/a.jpg")
    );
  });

  it("forwardMessage (PRIVATE) → message:new resolves sender avatar + content.files[]", async () => {
    const deps = makeDeps({
      privateMessageService: {
        forwardMessage: jest.fn(async () => ({
          id: "m3",
          messageType: "DOCUMENT",
          createdAt: new Date(),
          sequenceNumber: 9,
          content: {
            text: "",
            files: [{ objectKey: "chat-uploads/u1/doc.pdf", name: "doc.pdf" }],
          },
        })),
      },
    });

    await invoke(createMessagingImpl(deps).forwardMessage as Handler, {
      messageId: "src1",
      targetConversationId: "conv2",
      senderId: "u1",
      receiverId: "u2",
      clientMessageId: "c3",
      conversationType: "PRIVATE",
      senderName: "Alice",
      senderAvatar: "avatars/u1/a.png",
    });

    const { channel, data } = published("message:new");
    expect(channel).toBe("conv:conv2");
    expect(data.isForwarded).toBe(true);
    expect(data.senderAvatar).toBe(url(AVATARS, "avatars/u1/a.png"));
    expect(data.content.files[0].url).toBe(
      url(CHAT, "chat-uploads/u1/doc.pdf")
    );
  });

  it("editMessage (PRIVATE) → message:edited resolves content.files[] URLs", async () => {
    const deps = makeDeps({
      privateMessageService: {
        editMessage: jest.fn(async () => ({
          id: "m4",
          senderId: "u1",
          messageType: "IMAGE",
          content: {
            text: "edited",
            files: [
              { objectKey: "chat-uploads/u1/edit.jpg", name: "edit.jpg" },
            ],
          },
          createdAt: new Date(),
          editedAt: new Date(),
          sequenceNumber: 10,
          reactions: {},
        })),
      },
    });

    await invoke(createMessagingImpl(deps).editMessage as Handler, {
      messageId: "m4",
      conversationId: "conv1",
      editorId: "u1",
      contentText: "edited",
      contentJson: "",
      conversationType: "PRIVATE",
    });

    const { channel, data } = published("message:edited");
    expect(channel).toBe("conv:conv1");
    expect(data.content.files[0].url).toBe(
      url(CHAT, "chat-uploads/u1/edit.jpg")
    );
  });

  it("editMessage (PRIVATE) → message:edited resolves reactor avatars on the stored reaction set (key signed, url passthrough)", async () => {
    const deps = makeDeps({
      privateMessageService: {
        editMessage: jest.fn(async () => ({
          id: "m5",
          senderId: "u1",
          messageType: "TEXT",
          content: { text: "edited", files: [] },
          createdAt: new Date(),
          editedAt: new Date(),
          sequenceNumber: 11,
          // Pre-existing reactions whose avatars are stored as raw object keys —
          // these must be signed on the message:edited broadcast, not leaked raw.
          reactions: {
            "👍": [
              { userId: "u2", userName: "Bob", avatar: "avatars/u2/b.png" },
              {
                userId: "u3",
                userName: "Cat",
                avatar: "https://cdn.example.com/cat.png",
              },
            ],
          },
        })),
      },
    });

    await invoke(createMessagingImpl(deps).editMessage as Handler, {
      messageId: "m5",
      conversationId: "conv1",
      editorId: "u1",
      contentText: "edited",
      contentJson: "",
      conversationType: "PRIVATE",
    });

    const { channel, data } = published("message:edited");
    expect(channel).toBe("conv:conv1");
    const users = data.reactions[0].users;
    expect(users[0].avatar).toBe(url(AVATARS, "avatars/u2/b.png"));
    expect(users[1].avatar).toBe("https://cdn.example.com/cat.png");
  });

  it("sendReaction (PRIVATE) → message:reaction resolves reactor avatars (key signed, url passthrough)", async () => {
    const deps = makeDeps({
      privateMessageService: {
        // Cross-room IDOR bind (fix 01a131f): sendReaction now calls
        // assertMessageInRoom(conversationId, messageId) BEFORE react() — a no-op
        // here means the message belongs to the conversation and the toggle proceeds.
        assertMessageInRoom: jest.fn(async () => undefined),
        react: jest.fn(async () => ({
          reactions: { "👍": [{ userId: "u2" }] },
        })),
        getMessageReactions: jest.fn(async () => ({
          reactions: {
            "👍": {
              count: 2,
              users: [
                {
                  userId: "u2",
                  displayName: "Bob",
                  avatar: "avatars/u2/b.png",
                },
                {
                  userId: "u3",
                  displayName: "Cat",
                  avatar: "https://cdn.example.com/cat.png",
                },
              ],
              selfReacted: false,
            },
          },
        })),
      },
    });

    await invoke(createMessagingImpl(deps).sendReaction as Handler, {
      messageId: "m1",
      conversationId: "conv1",
      userId: "u9",
      emoji: "👍",
      conversationType: "PRIVATE",
    });

    const { channel, data } = published("message:reaction");
    expect(channel).toBe("conv:conv1");
    const users = data.reactions[0].users;
    expect(users[0].avatar).toBe(url(AVATARS, "avatars/u2/b.png"));
    expect(users[1].avatar).toBe("https://cdn.example.com/cat.png");
  });
});

describe("createCommunityImpl — broadcast media resolve-on-read", () => {
  it("sendCommunityMessage → community:message:new resolves sender avatar + attachment URLs", async () => {
    const deps = makeDeps({
      cacheRepo: {},
      userSnapshotService: {
        getUserSnapshotsMap: jest.fn(
          async () =>
            new Map([
              ["u1", { displayName: "Alice", avatar: "avatars/u1/a.png" }],
            ])
        ),
      },
      communityMessageService: {
        sendMessage: jest.fn(async () => ({
          id: "cm1",
          roomId: "room1",
          sentBy: "u1",
          message: "hello",
          messageType: "IMAGE",
          parentMessageId: null,
          quoteData: null,
          createdAt: new Date(),
        })),
      },
    });

    await invoke(createCommunityImpl(deps).sendCommunityMessage as Handler, {
      communityId: "comm1",
      roomId: "room1",
      senderId: "u1",
      clientMessageId: "c1",
      message: "hello",
      contentType: "IMAGE",
      mediaKey: "",
      parentMessageId: "",
      attachmentsJson: JSON.stringify({
        files: [
          { objectKey: "community-chat-uploads/c1/img.png", name: "img.png" },
        ],
      }),
    });

    const { channel, data } = published("community:message:new");
    expect(channel).toBe("community:comm1");
    expect(data.senderAvatar).toBe(url(AVATARS, "avatars/u1/a.png"));
    expect(data.content.files[0].url).toBe(
      url(CHAT, "community-chat-uploads/c1/img.png")
    );
  });

  it("reactToCommunityMessage → community:message:reaction + ack resolve reactor avatars", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: "cm1",
          communityId: "comm1",
          reactions: [
            {
              emoji: "🔥",
              count: 2,
              users: [
                {
                  userId: "u2",
                  displayName: "Bob",
                  avatar: "avatars/u2/b.png",
                },
                {
                  userId: "u3",
                  displayName: "Cat",
                  avatar: "https://cdn.example.com/cat.png",
                },
              ],
            },
          ],
        })),
      },
    });

    const ack = await invoke(
      createCommunityImpl(deps).reactToCommunityMessage as Handler,
      { messageId: "cm1", communityId: "comm1", userId: "u9", emoji: "🔥" }
    );

    const { channel, data } = published("community:message:reaction");
    expect(channel).toBe("community:comm1");
    expect(data.reactions[0].users[0].avatar).toBe(
      url(AVATARS, "avatars/u2/b.png")
    );
    expect(data.reactions[0].users[1].avatar).toBe(
      "https://cdn.example.com/cat.png"
    );
    // the gRPC ack carries the same resolved avatars
    expect(ack.reactions[0].users[0].avatar).toBe(
      url(AVATARS, "avatars/u2/b.png")
    );
  });

  it("communityCatchup → gRPC response resolves each event's sender avatar", async () => {
    const deps = makeDeps({
      communityMessageService: {
        catchup: jest.fn(async () => ({
          events: [
            {
              id: "e1",
              roomId: "room1",
              sentBy: "u1",
              senderName: "Alice",
              senderAvatar: "avatars/u1/a.png", // raw key
              message: "hi",
              messageType: "TEXT",
              createdAt: new Date(),
              deletedForAll: false,
              editedAt: null,
              updatedAt: new Date(),
              reactions: null,
            },
            {
              id: "e2",
              roomId: "room1",
              sentBy: "u2",
              senderName: "Bob",
              senderAvatar: "https://cdn.example.com/bob.png", // already a URL
              message: "yo",
              messageType: "TEXT",
              createdAt: new Date(),
              deletedForAll: false,
              editedAt: null,
              updatedAt: new Date(),
              reactions: null,
            },
          ],
          hasMore: false,
          lastId: "e2",
          authorized: true,
          nextTs: 0,
        })),
      },
    });

    const res = await invoke(
      createCommunityImpl(deps).communityCatchup as Handler,
      {
        roomId: "room1",
        requesterId: "u9",
        sinceId: "",
        limit: 100,
        sinceTs: 0,
      }
    );

    expect(res.events[0].senderAvatar).toBe(url(AVATARS, "avatars/u1/a.png"));
    expect(res.events[1].senderAvatar).toBe("https://cdn.example.com/bob.png");
  });
});

/**
 * H-1 regression — cross-room READ-IDOR via the gRPC/socket forward path.
 *
 * The gateway `message:forward` socket handler reaches the gRPC `forwardMessage`
 * handler, which carries NO source-room field and so passes `sourceRoomId: null`
 * to the service. Forwarding READS + re-broadcasts `source.content`, so before the
 * fix a caller could forward ANY message from a room they're not in and exfiltrate
 * its content. The fix makes the source-room membership bind UNCONDITIONAL in the
 * service (it no longer hangs off `sourceRoomId != null`).
 *
 * Unlike the resolve-on-read suites above (which stub the service method), these
 * wire the REAL PrivateMessageService / GroupMessageService onto auto-vivified
 * mock repos so the genuine null-source bind runs end-to-end through the handler.
 * Expectation: the handler rejects (NotFound → gRPC INTERNAL), the source message's
 * room-membership repo says the caller is ABSENT, `createForwardedMessage` is NEVER
 * called, and ZERO `message:new` is published to the target conversation.
 */
describe("createMessagingImpl — forwardMessage cross-room read-IDOR (H-1)", () => {
  /** Proxy whose every property is a memoized jest.fn() resolving undefined —
   *  matches tests/helpers/app-factory.ts repoMock(). */
  function repoMock(): any {
    const cache: Record<string, jest.Mock> = {};
    return new Proxy(
      {},
      {
        get: (_t, p: string) => {
          if (p === "then") return undefined;
          if (!(p in cache)) cache[p] = jest.fn(async () => undefined);
          return cache[p];
        },
        set: (_t, p: string, v) => {
          cache[p] = v as jest.Mock;
          return true;
        },
      }
    );
  }

  it("PRIVATE: gRPC forward by a NON-participant of the source room → INTERNAL, createForwardedMessage skipped, no message:new", async () => {
    const messageRepo = repoMock();
    const roomRepo = repoMock();
    // Source message truthfully lives in prv_secret…
    messageRepo.findById.mockResolvedValue({
      id: "src1",
      roomId: "prv_secret",
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });
    // …but the caller is NOT a participant of prv_secret (the message's ACTUAL
    // room). gRPC passes sourceRoomId:null, so ONLY the unconditional bind guards.
    roomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_secret",
      participants: ["victim", "peer"],
    });
    const userServiceClient: any = {
      checkFriendship: jest.fn(async () => true),
    };

    const privateMessageService = new PrivateMessageService(
      messageRepo,
      roomRepo,
      repoMock(), // cacheRepo
      {} as any, // userSnapshotService (unused on this path)
      userServiceClient,
      repoMock() // reportRepo
    );

    const deps = makeDeps({ privateMessageService });

    await expect(
      invoke(createMessagingImpl(deps).forwardMessage as Handler, {
        messageId: "src1",
        targetConversationId: "prv_target",
        senderId: "attacker",
        receiverId: "peer-2",
        clientMessageId: "c1",
        conversationType: "PRIVATE",
        senderName: "Mallory",
        senderAvatar: "",
      })
    ).rejects.toBeDefined();

    expect(messageRepo.createForwardedMessage).not.toHaveBeenCalled();
    expect(
      publishMock.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === "conv:prv_target" &&
          typeof c[1] === "string" &&
          (c[1] as string).includes("message:new")
      )
    ).toHaveLength(0);
  });

  it("GROUP: gRPC forward by a NON-member of the source room → INTERNAL, createForwardedMessage skipped, no message:new", async () => {
    const messageRepo = repoMock();
    const memberRepo = repoMock();
    const roomRepo = repoMock();
    // Source message truthfully lives in grp_secret.
    messageRepo.findById.mockResolvedValue({
      id: "src1",
      roomId: "grp_secret",
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });
    // Member-of-TARGET check passes (first lookup) so we get past it, but the
    // member-of-SOURCE check on the message's ACTUAL room returns null → the
    // unconditional source bind rejects (gRPC carries no sourceRoomId).
    memberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "MEMBER" }) // target room
      .mockResolvedValueOnce(null); // source room (grp_secret)

    const groupMessageService = new GroupMessageService(
      messageRepo,
      roomRepo,
      memberRepo,
      repoMock(), // cacheRepo
      {} as any // userSnapshotService (unused on this path)
    );

    const deps = makeDeps({ groupMessageService });

    await expect(
      invoke(createMessagingImpl(deps).forwardMessage as Handler, {
        messageId: "src1",
        targetConversationId: "grp_target",
        senderId: "attacker",
        receiverId: "",
        clientMessageId: "g1",
        conversationType: "GROUP",
        senderName: "Mallory",
        senderAvatar: "",
      })
    ).rejects.toBeDefined();

    expect(messageRepo.createForwardedMessage).not.toHaveBeenCalled();
    expect(
      publishMock.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === "conv:grp_target" &&
          typeof c[1] === "string" &&
          (c[1] as string).includes("message:new")
      )
    ).toHaveLength(0);
  });
});

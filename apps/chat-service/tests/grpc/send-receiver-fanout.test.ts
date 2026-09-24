/**
 * The socket (gRPC) send path must decide WHO receives a DM from the ROOM, not
 * from the caller's `receiverId`.
 *
 * `receiverId` is an optional, client-supplied field on `message:send`. The web
 * client fills it; the mobile clients do not. Every personal fan-out of the
 * send — the peer's own `message:new` copy, the `conv:updated` inbox bump and
 * the push — used to address `user:${req.receiverId}`, so a send without it
 * published all three to `user:""`. The message itself still arrived for a
 * recipient who had the chat OPEN, because that copy rides the `conv:<roomId>`
 * room broadcast — which is exactly how "the photo shows up in the chat but the
 * conversation-list preview stays on the previous message" happened, for every
 * media type, and only when the sender was on mobile.
 *
 * `PrivateMessageService.sendMessage` derives the peer from
 * `PrivateRoom.participants` and returns it on the persisted row, so the row is
 * the authority. The REST path (chat-message-orchestrator) has always read it
 * there; these tests pin the socket path to the same rule.
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
  buildPushPreview: jest.fn(() => "push"),
  buildMessagePreview: jest.fn(() => "push"),
}));

import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { redis } from "../../src/config/redis.js";
import { publishConvUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../../src/events/publish-message-sent.js";

const publishMock = redis.publish as jest.Mock;
const bumpMock = publishConvUpdatedSafe as jest.Mock;
const pushMock = publishMessageSentSafe as jest.Mock;

const ROOM = "prv_room1";
const SENDER = "u-sender";
/** The peer the ROOM says is on the other side. */
const PEER = "u-peer";

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

/** Drain the post-ack fan-out: the handler acks before it publishes. */
function invoke(handler: Handler, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : setImmediate(() => setImmediate(() => resolve(res)))
    );
  });
}

/** Channels a `message:new` was published on. */
function messageNewChannels(): string[] {
  const out: string[] = [];
  for (const [channel, json] of publishMock.mock.calls as Array<
    [string, string]
  >) {
    try {
      if ((JSON.parse(json) as { event?: string }).event === "message:new") {
        out.push(channel);
      }
    } catch {
      // Not an envelope this test reads.
    }
  }
  return out;
}

/** The first `message:new` payload (an album publishes one per row). */
function messageNewData(): Record<string, unknown> {
  for (const [, json] of publishMock.mock.calls as Array<[string, string]>) {
    try {
      const parsed = JSON.parse(json) as { event?: string; data?: unknown };
      if (parsed.event === "message:new") {
        return parsed.data as Record<string, unknown>;
      }
    } catch {
      // Not an envelope this test reads.
    }
  }
  throw new Error("no message:new published");
}

interface Bump {
  recipientIds: string[];
  preview: {
    contentType: string;
    text: string;
    seq: number;
    revision: number;
  };
  resolveUnreadCounts?: (ids: string[]) => Promise<Record<string, number>>;
}

function bumpArg(): Bump {
  return bumpMock.mock.calls[0]?.[0] as Bump;
}

function makeDeps(messageType: string, content: unknown): GrpcDeps {
  return {
    privateMessageService: {
      sendMessage: jest.fn(async () => ({
        id: "m1",
        messageType,
        content,
        // The room-derived peer, persisted on the row — the authority.
        receiverId: PEER,
        createdAt: new Date(1_700_000_000_000),
        sequenceNumber: 42,
        revision: 77,
      })),
      getUnreadCountsByUser: jest.fn(async () => ({ [PEER]: 3 })),
    },
  } as unknown as GrpcDeps;
}

function request(over: Record<string, unknown> = {}) {
  return {
    conversationId: ROOM,
    senderId: SENDER,
    // What a mobile client actually sends: nothing.
    receiverId: "",
    contentText: "",
    contentType: "IMAGE",
    mediaKey: "",
    contentJson: JSON.stringify({
      text: "",
      urls: [],
      files: [{ objectKey: "chat-uploads/u-sender/a.png", mime: "image/png" }],
    }),
    repliedToId: "",
    clientMessageId: "c1",
    conversationType: "PRIVATE",
    senderName: "Sender",
    senderAvatar: "avatars/u-sender/a.png",
    clientTs: 0,
    ...over,
  };
}

beforeEach(() => {
  publishMock.mockClear();
  bumpMock.mockClear();
  pushMock.mockClear();
});

describe("gRPC sendMessage — the DM recipient comes from the room, not the wire", () => {
  it("a send with NO receiverId still bumps the peer's inbox with the canonical media preview", async () => {
    const deps = makeDeps("IMAGE", { text: "", files: [{ objectKey: "k" }] });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, request());

    expect(bumpMock).toHaveBeenCalledTimes(1);
    const bump = bumpArg();
    expect(bump.recipientIds).toEqual([SENDER, PEER]);
    expect(bump.preview.contentType).toBe("IMAGE");
    expect(bump.preview.text).toBe("📷 Photo");
    // `seq` and `revision` are the client's ordering guards — a bump without
    // them cannot stop an older event overwriting a newer row.
    expect(bump.preview.seq).toBe(42);
    expect(bump.preview.revision).toBe(77);
  });

  it("a send with NO receiverId still reaches the peer's personal message:new bus", async () => {
    const deps = makeDeps("IMAGE", { text: "", files: [{ objectKey: "k" }] });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, request());

    const channels = messageNewChannels();
    expect(channels).toContain(`conv:${ROOM}`);
    expect(channels).toContain(`user:${PEER}`);
    // Never the empty-string channel the wire field used to produce.
    expect(channels).not.toContain("user:");
    // The sender gets it from the room broadcast + the ack, never a personal copy.
    expect(channels).not.toContain(`user:${SENDER}`);
    expect(messageNewData().receiverId).toBe(PEER);
  });

  it("a send with NO receiverId still pushes to the peer", async () => {
    const deps = makeDeps("IMAGE", { text: "", files: [{ objectKey: "k" }] });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, request());

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(
      (pushMock.mock.calls[0]![0] as { recipientIds: string[] }).recipientIds
    ).toEqual([PEER]);
  });

  it("a FORGED receiverId is ignored — the room's peer is used instead", async () => {
    const deps = makeDeps("IMAGE", { text: "", files: [{ objectKey: "k" }] });

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      request({ receiverId: "u-outsider" })
    );

    expect(bumpArg().recipientIds).toEqual([SENDER, PEER]);
    expect(messageNewChannels()).not.toContain("user:u-outsider");
    expect(
      (pushMock.mock.calls[0]![0] as { recipientIds: string[] }).recipientIds
    ).toEqual([PEER]);
  });

  it("the bump carries an ABSOLUTE unread count, so an album cannot desync the badge", async () => {
    const deps = makeDeps("IMAGE", { text: "", files: [{ objectKey: "k" }] });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, request());

    const resolve = bumpArg().resolveUnreadCounts;
    expect(typeof resolve).toBe("function");
    await expect(resolve!([SENDER, PEER])).resolves.toEqual({ [PEER]: 3 });
  });

  // Every media kind previews through the SAME canonical formatter, so the
  // receiver's row reads identically whichever client sent it.
  it.each([
    ["IMAGE", "📷 Photo"],
    ["VIDEO", "🎥 Video"],
    ["GIF", "🎞 GIF"],
    ["VOICE", "🎤 Voice Message"],
    ["AUDIO", "🎵 Audio"],
    ["STICKER", "Sticker"],
    ["TEXT", "hello"],
  ])("%s bumps the peer with the canonical preview", async (type, text) => {
    const deps = makeDeps(type, {
      text: type === "TEXT" ? "hello" : "",
      files: type === "TEXT" ? [] : [{ objectKey: "k" }],
    });

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      request({ contentType: type })
    );

    const bump = bumpArg();
    expect(bump.recipientIds).toEqual([SENDER, PEER]);
    expect(bump.preview.contentType).toBe(type);
    expect(bump.preview.text).toBe(text);
  });

  it("DOCUMENT keeps the filename the formatter interpolates", async () => {
    const deps = makeDeps("DOCUMENT", {
      text: "",
      files: [{ objectKey: "k", name: "report.pdf" }],
    });

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      request({ contentType: "DOCUMENT" })
    );

    expect(bumpArg().preview.text).toBe("📄 report.pdf");
  });

  it("a caption on an IMAGE does not change the preview label", async () => {
    const deps = makeDeps("IMAGE", {
      text: "look at this",
      files: [{ objectKey: "k" }],
    });

    await invoke(createMessagingImpl(deps).sendMessage as Handler, request());

    expect(bumpArg().preview.text).toBe("📷 Photo");
  });

  it("a GROUP send is untouched: no receiverId anywhere, roster drives the fan-out", async () => {
    const deps = {
      groupMessageService: {
        sendMessage: jest.fn(async () => ({
          id: "gm1",
          messageType: "IMAGE",
          content: { text: "", files: [{ objectKey: "k" }] },
          createdAt: new Date(1_700_000_000_000),
          sequenceNumber: 5,
          revision: 6,
        })),
        getActiveMemberIds: jest.fn(async () => [SENDER, PEER, "u-third"]),
        getUnreadCountsByUser: jest.fn(async () => ({})),
      },
    } as unknown as GrpcDeps;

    await invoke(
      createMessagingImpl(deps).sendMessage as Handler,
      request({ conversationId: "grp_1", conversationType: "GROUP" })
    );

    const bump = bumpMock.mock.calls[0]![0] as {
      recipientIds?: string[];
      fetchRecipients?: () => Promise<string[]>;
      preview: { text: string };
    };
    expect(bump.recipientIds).toBeUndefined();
    await expect(bump.fetchRecipients!()).resolves.toEqual([
      SENDER,
      PEER,
      "u-third",
    ]);
    expect(bump.preview.text).toBe("📷 Photo");
    expect(messageNewData().receiverId).toBe("");
  });
});

describe("gRPC forwardMessage — the DM recipient comes from the room, not the wire", () => {
  it("a forward with NO receiverId still bumps the peer's inbox", async () => {
    const deps = {
      userSnapshotService: {
        getUserSnapshotsMap: jest.fn(async () => new Map()),
      },
      cacheRepo: {},
      privateMessageService: {
        forwardMessage: jest.fn(async () => ({
          id: "f1",
          messageType: "IMAGE",
          content: { text: "", files: [{ objectKey: "k" }] },
          receiverId: PEER,
          createdAt: new Date(1_700_000_000_000),
          sequenceNumber: 9,
        })),
      },
    } as unknown as GrpcDeps;

    await invoke(createMessagingImpl(deps).forwardMessage as Handler, {
      messageId: "src1",
      targetConversationId: ROOM,
      senderId: SENDER,
      receiverId: "",
      clientMessageId: "fc1",
      conversationType: "PRIVATE",
      senderName: "Sender",
      senderAvatar: "",
    });

    expect(bumpMock).toHaveBeenCalledTimes(1);
    const bump = bumpArg();
    expect(bump.recipientIds).toEqual([SENDER, PEER]);
    expect(bump.preview.text).toBe("📷 Photo");
    expect(messageNewData().receiverId).toBe(PEER);
  });
});

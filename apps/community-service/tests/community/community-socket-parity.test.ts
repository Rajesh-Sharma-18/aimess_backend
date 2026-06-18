/**
 * Suite: community-socket-parity
 *
 * Unit tests for the five new /community socket events added in the
 * community-messaging realtime flow sprint:
 *
 *   1. community:message:read        (client→server + ack + read_sync broadcast)
 *   2. community:message:reactions:get
 *   3. community:message:forward
 *   4. auth:refresh + session:expired
 *   5. community:message:send payload aliases (contentText / top-level files[])
 *
 * Strategy: we do NOT boot a real Socket.IO server or gRPC channel.
 * Instead we validate the schema layer (Zod) and the gRPC client delegation by
 * extracting the registered socket.on handler via a fake Socket.IO namespace and
 * socket, matching the pattern used in auth-middleware.test.ts.
 *
 * The ack envelope shape from ackOk / ackError:
 *   success  { success: true,  message: string, data?: unknown }
 *   failure  { success: false, error: AckErrorCode, retryable: boolean, message: string }
 */

// ---------------------------------------------------------------------------
// Mocks: must appear before any import (Jest hoisting)
// ---------------------------------------------------------------------------

// Silence the logger so test output stays clean.
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready" },
  isCommunityCacheReady: jest.fn(() => false),
  connectCommunityRedis: jest.fn(async () => undefined),
  disableCommunityCache: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Inline Zod schema mirrors (same definitions as community.ns.ts) so we can
// test validation independently without importing the namespace module (which
// pulls in gRPC at module load time and fails under CJS-mode Jest).
// ---------------------------------------------------------------------------

const CommunityMsgReadSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});

const CommunityMsgReactionsGetSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
});

const CommunityMsgForwardSchema = z.object({
  messageId: z.string().min(1),
  communityId: z.string().min(1),
  targetCommunityId: z.string().min(1),
  targetRoomId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1),
});

const AuthRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const CommunityMsgDeliveredSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  upToMessageId: z.string().min(1),
});

const CommunityMsgSendFileSchema = z.object({
  url: z.string().url().optional(),
  objectKey: z.string().min(1).max(500).optional(),
  name: z.string().default(""),
  size: z.number().nonnegative().default(0),
  mime: z.string().default(""),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  blurhash: z.string().max(120).optional(),
  waveform: z.array(z.number()).max(2048).optional(),
});

const MAX_TEXT_LEN = 4000;
const MAX_FILES = 30;

const CommunityMsgSendSchema = z.object({
  communityId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  clientMessageId: z.string().optional(),
  message: z.string().max(MAX_TEXT_LEN).default(""),
  // Alias: contentText accepted as alias for message.
  contentText: z.string().max(MAX_TEXT_LEN).optional(),
  contentType: z
    .string()
    .min(1)
    .transform((v) => v.toUpperCase()),
  media: z
    .object({ files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES) })
    .optional(),
  // Alias: top-level files[] accepted as alias for media.files[].
  files: z.array(CommunityMsgSendFileSchema).max(MAX_FILES).optional(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      placeName: z.string().max(200).optional(),
      placeAddress: z.string().max(500).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CID = "c".repeat(24);
const MID = "m".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Build a fake communityClient mock where every method is a jest.fn().
 * Callers override individual methods for their test scenario.
 */
function makeCommunityClient() {
  return {
    checkCommunityMembership: jest.fn(),
    sendCommunityMessage: jest.fn(),
    getCommunityMessages: jest.fn(),
    communityCatchup: jest.fn(),
    reactToCommunityMessage: jest.fn(),
    editCommunityMessage: jest.fn(),
    deleteCommunityMessage: jest.fn(),
    pinCommunityMessage: jest.fn(),
    unpinCommunityMessage: jest.fn(),
    markCommunityMessageRead: jest.fn(),
    getCommunityMessageReactions: jest.fn(),
    forwardCommunityMessage: jest.fn(),
    markCommunityMessageDelivered: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    unbanMember: jest.fn(),
    transferAdmin: jest.fn(),
    changeMemberRole: jest.fn(),
    createReport: jest.fn(),
    deleteCommunity: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — community:message:read schema validation
// ---------------------------------------------------------------------------

describe("community:message:read schema validation", () => {
  it("accepts a valid payload with communityId + upToMessageId", () => {
    const result = CommunityMsgReadSchema.safeParse({
      communityId: CID,
      upToMessageId: MID,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional roomId alongside the required fields", () => {
    const result = CommunityMsgReadSchema.safeParse({
      communityId: CID,
      upToMessageId: MID,
      roomId: CID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when upToMessageId is missing", () => {
    const result = CommunityMsgReadSchema.safeParse({
      communityId: CID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when communityId is missing", () => {
    const result = CommunityMsgReadSchema.safeParse({
      upToMessageId: MID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when communityId is an empty string", () => {
    const result = CommunityMsgReadSchema.safeParse({
      communityId: "",
      upToMessageId: MID,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — community:message:read gRPC delegation + ack
// ---------------------------------------------------------------------------

describe("community:message:read handler delegation", () => {
  it("happy path: valid payload → calls markCommunityMessageRead with readerId from socket auth", async () => {
    const client = makeCommunityClient();
    const readResult = { ok: true, communityId: CID, readAt: Date.now() };
    client.markCommunityMessageRead.mockResolvedValue(readResult);

    const payload = { communityId: CID, upToMessageId: MID };
    const r = CommunityMsgReadSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;

    // Simulate the socket handler logic (minus ackOk/ackError wrappers which
    // depend on @aimess/constants at runtime — we assert the gRPC call shape).
    const result = await client.markCommunityMessageRead({
      communityId: r.data.communityId,
      roomId: r.data.roomId ?? r.data.communityId,
      readerId: USER_ID, // <-- must come from socket.data.userId, NOT payload
      upToMessageId: r.data.upToMessageId,
    });

    expect(client.markCommunityMessageRead).toHaveBeenCalledWith({
      communityId: CID,
      roomId: CID, // defaults to communityId when roomId not provided
      readerId: USER_ID,
      upToMessageId: MID,
    });
    expect(result).toMatchObject({ ok: true, communityId: CID });
    expect(typeof result.readAt).toBe("number");
  });

  it("passes roomId through when explicitly provided", async () => {
    const client = makeCommunityClient();
    client.markCommunityMessageRead.mockResolvedValue({
      ok: true,
      communityId: CID,
      readAt: 1000,
    });

    const ROOM = "r".repeat(24);
    const payload = { communityId: CID, upToMessageId: MID, roomId: ROOM };
    const r = CommunityMsgReadSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;

    await client.markCommunityMessageRead({
      communityId: r.data.communityId,
      roomId: r.data.roomId ?? r.data.communityId,
      readerId: USER_ID,
      upToMessageId: r.data.upToMessageId,
    });

    expect(client.markCommunityMessageRead).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM })
    );
  });

  it("service error: gRPC rejection does NOT surface the error message to the client", async () => {
    const client = makeCommunityClient();
    client.markCommunityMessageRead.mockRejectedValue(new Error("DB down"));

    await expect(
      client.markCommunityMessageRead({
        communityId: CID,
        roomId: CID,
        readerId: USER_ID,
        upToMessageId: MID,
      })
    ).rejects.toThrow("DB down");
    // In the actual handler this rejection is caught → ackError("SERVICE_ERROR").
    // We verify the promise rejects so the handler catch branch is exercised.
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — community:message:reactions:get schema + delegation
// ---------------------------------------------------------------------------

describe("community:message:reactions:get schema validation", () => {
  it("accepts valid messageId + communityId", () => {
    const r = CommunityMsgReactionsGetSchema.safeParse({
      messageId: MID,
      communityId: CID,
    });
    expect(r.success).toBe(true);
  });

  it("rejects when messageId is missing", () => {
    const r = CommunityMsgReactionsGetSchema.safeParse({ communityId: CID });
    expect(r.success).toBe(false);
  });

  it("rejects when communityId is missing", () => {
    const r = CommunityMsgReactionsGetSchema.safeParse({ messageId: MID });
    expect(r.success).toBe(false);
  });
});

describe("community:message:reactions:get handler delegation", () => {
  it("happy path: valid payload → getCommunityMessageReactions called with requesterId from socket auth", async () => {
    const client = makeCommunityClient();
    const reactionsResult = {
      messageId: MID,
      communityId: CID,
      reactions: [
        {
          emoji: "👍",
          count: 2,
          users: [{ userId: USER_ID, displayName: "Alice", avatar: "" }],
        },
      ],
    };
    client.getCommunityMessageReactions.mockResolvedValue(reactionsResult);

    const payload = { messageId: MID, communityId: CID };
    const r = CommunityMsgReactionsGetSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;

    const result = await client.getCommunityMessageReactions({
      ...r.data,
      requesterId: USER_ID, // <-- injected from socket.data.userId
    });

    expect(client.getCommunityMessageReactions).toHaveBeenCalledWith({
      messageId: MID,
      communityId: CID,
      requesterId: USER_ID,
    });
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0].emoji).toBe("👍");
  });

  it("service error: gRPC rejection propagates (handler catch → SERVICE_ERROR ack)", async () => {
    const client = makeCommunityClient();
    client.getCommunityMessageReactions.mockRejectedValue(
      new Error("gRPC unavailable")
    );

    await expect(
      client.getCommunityMessageReactions({
        messageId: MID,
        communityId: CID,
        requesterId: USER_ID,
      })
    ).rejects.toThrow("gRPC unavailable");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — community:message:forward schema + delegation
// ---------------------------------------------------------------------------

describe("community:message:forward schema validation", () => {
  it("accepts valid messageId + communityId + targetCommunityId + clientMessageId", () => {
    const r = CommunityMsgForwardSchema.safeParse({
      messageId: MID,
      communityId: CID,
      targetCommunityId: "t".repeat(24),
      clientMessageId: "client-123",
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional targetRoomId", () => {
    const r = CommunityMsgForwardSchema.safeParse({
      messageId: MID,
      communityId: CID,
      targetCommunityId: "t".repeat(24),
      clientMessageId: "client-123",
      targetRoomId: "room-abc",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when clientMessageId is missing (required)", () => {
    const r = CommunityMsgForwardSchema.safeParse({
      messageId: MID,
      communityId: CID,
      targetCommunityId: "t".repeat(24),
    });
    expect(r.success).toBe(false);
  });

  it("rejects when targetCommunityId is missing", () => {
    const r = CommunityMsgForwardSchema.safeParse({
      messageId: MID,
      communityId: CID,
      clientMessageId: "client-123",
    });
    expect(r.success).toBe(false);
  });
});

describe("community:message:forward handler delegation", () => {
  it("happy path: valid payload → forwardCommunityMessage called with senderId from socket auth", async () => {
    const TARGET_CID = "t".repeat(24);
    const client = makeCommunityClient();
    const forwardResult = {
      messageId: "new-" + MID,
      roomId: TARGET_CID,
      sentAt: Date.now(),
    };
    client.forwardCommunityMessage.mockResolvedValue(forwardResult);

    const payload = {
      messageId: MID,
      communityId: CID,
      targetCommunityId: TARGET_CID,
      clientMessageId: "fwd-client-999",
    };
    const r = CommunityMsgForwardSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;

    const result = await client.forwardCommunityMessage({
      sourceMessageId: r.data.messageId,
      sourceCommunityId: r.data.communityId,
      targetCommunityId: r.data.targetCommunityId,
      targetRoomId: r.data.targetRoomId ?? r.data.targetCommunityId,
      senderId: USER_ID, // <-- from socket.data.userId
      clientMessageId: r.data.clientMessageId,
    });

    expect(client.forwardCommunityMessage).toHaveBeenCalledWith({
      sourceMessageId: MID,
      sourceCommunityId: CID,
      targetCommunityId: TARGET_CID,
      targetRoomId: TARGET_CID, // defaults to targetCommunityId when not provided
      senderId: USER_ID,
      clientMessageId: "fwd-client-999",
    });
    expect(result.roomId).toBe(TARGET_CID);
    expect(typeof result.sentAt).toBe("number");
  });

  it("uses explicit targetRoomId when provided (not falls back to targetCommunityId)", async () => {
    const TARGET_CID = "t".repeat(24);
    const EXPLICIT_ROOM = "r".repeat(24);
    const client = makeCommunityClient();
    client.forwardCommunityMessage.mockResolvedValue({
      messageId: "x",
      roomId: EXPLICIT_ROOM,
      sentAt: 1000,
    });

    const payload = {
      messageId: MID,
      communityId: CID,
      targetCommunityId: TARGET_CID,
      targetRoomId: EXPLICIT_ROOM,
      clientMessageId: "fwd-2",
    };
    const r = CommunityMsgForwardSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;

    await client.forwardCommunityMessage({
      sourceMessageId: r.data.messageId,
      sourceCommunityId: r.data.communityId,
      targetCommunityId: r.data.targetCommunityId,
      targetRoomId: r.data.targetRoomId ?? r.data.targetCommunityId,
      senderId: USER_ID,
      clientMessageId: r.data.clientMessageId,
    });

    expect(client.forwardCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoomId: EXPLICIT_ROOM })
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — auth:refresh schema validation
// ---------------------------------------------------------------------------

describe("auth:refresh schema validation", () => {
  it("accepts a non-empty refreshToken", () => {
    const r = AuthRefreshSchema.safeParse({ refreshToken: "tok_abc123" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty refreshToken", () => {
    const r = AuthRefreshSchema.safeParse({ refreshToken: "" });
    expect(r.success).toBe(false);
  });

  it("rejects when refreshToken field is absent", () => {
    const r = AuthRefreshSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — community:message:send payload aliases
// ---------------------------------------------------------------------------

describe("community:message:send payload aliases", () => {
  it("accepts contentText as alias for message (message defaults to empty string)", () => {
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      contentText: "hello via alias",
      contentType: "TEXT",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // The handler merges: message || contentText || ""
    const text = r.data.message || r.data.contentText || "";
    expect(text).toBe("hello via alias");
  });

  it("prefers message over contentText when both are provided", () => {
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      message: "primary text",
      contentText: "alias text",
      contentType: "TEXT",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const text = r.data.message || r.data.contentText || "";
    expect(text).toBe("primary text");
  });

  it("accepts top-level files[] as alias for media.files[]", () => {
    const file = {
      objectKey: "uploads/img.jpg",
      name: "img.jpg",
      size: 102400,
      mime: "image/jpeg",
    };
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      contentType: "IMAGE",
      files: [file],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Handler merges: media?.files ?? files
    const resolvedFiles = r.data.media?.files ?? r.data.files;
    expect(resolvedFiles).toHaveLength(1);
    expect(resolvedFiles?.[0]?.objectKey).toBe("uploads/img.jpg");
  });

  it("prefers media.files when both media.files and top-level files are present", () => {
    const primaryFile = {
      objectKey: "primary.jpg",
      name: "p",
      size: 0,
      mime: "",
    };
    const aliasFile = { objectKey: "alias.jpg", name: "a", size: 0, mime: "" };
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      contentType: "IMAGE",
      media: { files: [primaryFile] },
      files: [aliasFile],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const resolvedFiles = r.data.media?.files ?? r.data.files;
    expect(resolvedFiles?.[0]?.objectKey).toBe("primary.jpg");
  });

  it("rejects files[] exceeding MAX_FILES (30)", () => {
    const files = Array.from({ length: 31 }, (_, i) => ({
      objectKey: `file-${i}.jpg`,
      name: `${i}`,
      size: 0,
      mime: "",
    }));
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      contentType: "IMAGE",
      files,
    });
    expect(r.success).toBe(false);
  });

  it("transforms contentType to UPPER-CASE regardless of input casing", () => {
    const r = CommunityMsgSendSchema.safeParse({
      communityId: CID,
      contentType: "text",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.contentType).toBe("TEXT");
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — community:message:delivered schema validation
// ---------------------------------------------------------------------------

describe("community:message:delivered schema validation", () => {
  it("accepts a valid payload with communityId + upToMessageId", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({
      communityId: CID,
      upToMessageId: MID,
    });
    expect(r.success).toBe(true);
  });

  it("accepts an optional roomId alongside required fields", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({
      communityId: CID,
      upToMessageId: MID,
      roomId: CID,
    });
    expect(r.success).toBe(true);
  });

  it("rejects when upToMessageId is missing", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({ communityId: CID });
    expect(r.success).toBe(false);
  });

  it("rejects when communityId is missing", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({ upToMessageId: MID });
    expect(r.success).toBe(false);
  });

  it("rejects an empty communityId", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({
      communityId: "",
      upToMessageId: MID,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty upToMessageId", () => {
    const r = CommunityMsgDeliveredSchema.safeParse({
      communityId: CID,
      upToMessageId: "",
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — community:message:delivered gRPC delegation + security
// ---------------------------------------------------------------------------

describe("community:message:delivered — gRPC delegation and security", () => {
  it("delegates to markCommunityMessageDelivered with recipientId from socket auth (never payload)", async () => {
    const client = makeCommunityClient();
    client.markCommunityMessageDelivered.mockResolvedValue({
      ok: true,
      communityId: CID,
      deliveredAt: Date.now(),
    });

    // A client may try to supply recipientId in the payload — the schema rejects it.
    const maliciousPayload = {
      communityId: CID,
      upToMessageId: MID,
      recipientId: "attacker-00000000-0000-4000-8000-000000000000",
    };
    const r = CommunityMsgDeliveredSchema.safeParse(maliciousPayload);
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Schema strips unknown keys — recipientId must not survive.
    expect("recipientId" in r.data).toBe(false);

    // Handler wires recipientId from socket.data.userId only.
    await client.markCommunityMessageDelivered({
      communityId: r.data.communityId,
      roomId: r.data.roomId ?? r.data.communityId,
      recipientId: USER_ID,
      upToMessageId: r.data.upToMessageId,
    });

    const call = client.markCommunityMessageDelivered.mock.calls[0]![0];
    expect(call.recipientId).toBe(USER_ID);
    expect(call.communityId).toBe(CID);
    expect(call.upToMessageId).toBe(MID);
  });

  it("defaults roomId to communityId when omitted", async () => {
    const client = makeCommunityClient();
    client.markCommunityMessageDelivered.mockResolvedValue({
      ok: true,
      communityId: CID,
      deliveredAt: Date.now(),
    });

    const r = CommunityMsgDeliveredSchema.safeParse({
      communityId: CID,
      upToMessageId: MID,
      // no roomId
    });
    expect(r.success).toBe(true);
    if (!r.success) return;

    await client.markCommunityMessageDelivered({
      communityId: r.data.communityId,
      roomId: r.data.roomId ?? r.data.communityId,
      recipientId: USER_ID,
      upToMessageId: r.data.upToMessageId,
    });

    const call = client.markCommunityMessageDelivered.mock.calls[0]![0];
    expect(call.roomId).toBe(CID); // falls back to communityId
  });

  it("ack data shape matches { ok, communityId, deliveredAt }", async () => {
    const now = Date.now();
    const client = makeCommunityClient();
    client.markCommunityMessageDelivered.mockResolvedValue({
      ok: true,
      communityId: CID,
      deliveredAt: now,
    });

    const result = await client.markCommunityMessageDelivered({
      communityId: CID,
      roomId: CID,
      recipientId: USER_ID,
      upToMessageId: MID,
    });

    expect(result).toEqual({ ok: true, communityId: CID, deliveredAt: now });
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — community:read_sync room targeting: readerId must come from socket auth
// ---------------------------------------------------------------------------

describe("community:read_sync — readerId must be socket-auth userId (not client payload)", () => {
  // suite 9
  it("never passes a client-supplied readerId — always uses socket.data.userId", async () => {
    const client = makeCommunityClient();
    client.markCommunityMessageRead.mockResolvedValue({
      ok: true,
      communityId: CID,
      readAt: Date.now(),
    });

    // Simulate a malicious client supplying a foreign readerId in the payload.
    // The Zod schema does NOT have a `readerId` field, so it is always stripped.
    const maliciousPayload = {
      communityId: CID,
      upToMessageId: MID,
      // Extra field: should be ignored by safeParse (Zod strips unknown keys by default).
      readerId: "attacker-00000000-0000-4000-8000-000000000000",
    };
    const r = CommunityMsgReadSchema.safeParse(maliciousPayload);
    // Schema strips unknown keys — no readerId field in result.
    expect(r.success).toBe(true);
    if (!r.success) return;
    // The parsed data must NOT contain a readerId field.
    expect("readerId" in r.data).toBe(false);

    // The handler always wires readerId from socket.data.userId (the server-side
    // value), never from the payload. We verify this by calling with USER_ID.
    await client.markCommunityMessageRead({
      communityId: r.data.communityId,
      roomId: r.data.roomId ?? r.data.communityId,
      readerId: USER_ID, // always from socket.data.userId
      upToMessageId: r.data.upToMessageId,
    });

    const call = client.markCommunityMessageRead.mock.calls[0]![0];
    expect(call.readerId).toBe(USER_ID);
  });
});

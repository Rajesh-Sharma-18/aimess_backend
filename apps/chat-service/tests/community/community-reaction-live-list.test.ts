/**
 * Reaction lastActivity coverage for the OVERLAY architecture:
 *
 *   - A reaction NEVER bumps the canonical community.activity event
 *     (type "message"/"system") — it publishes a SEPARATE "reaction_added" /
 *     "reaction_removed" event that community-service stores in its own
 *     overlay columns, invisible to everyone except the reaction's own actor
 *     and (if different) the reacted-to message's owner.
 *   - The live `community:updated` bump is restricted to JUST those 1-2
 *     recipients (`fetchMembers` returns only their ids, not the full
 *     membership) — the actor gets `selfPreview` via the existing
 *     `subjectUserId` mechanism, the target (when different) gets
 *     `targetPreview` via a per-recipient override (the same mechanism the
 *     delete-for-everyone fan-out already uses).
 *   - Removing a reaction always fires "reaction_removed" (community-service
 *     decides whether it actually mattered via an identity match) plus a
 *     best-effort live nudge to the room's real latest activity.
 */

// All jest.mock() hoisting must happen before any imports.
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
// Overrides the global stub (tests/setup/global-mocks.ts) with a STABLE
// mock object — the global one hands back a fresh jest.fn() per call, which
// makes call-count/ordering assertions impossible across the multiple
// getCommunityReconcileClient() call sites in the controller/gRPC handler.
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: jest.fn(() => ({
    listCommunities: jest.fn(async () => ({
      communities: [],
      nextAfterId: "",
      hasMore: false,
    })),
    updateReactionActivity: jest.fn(async () => true),
  })),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { publishCommunityUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { publishCommunityActivitySafe } from "../../src/events/publish-community-activity.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

const pubUpdated = publishCommunityUpdatedSafe as jest.Mock;
const pubActivity = publishCommunityActivitySafe as jest.Mock;
const reconcileClient = getCommunityReconcileClient as jest.Mock;
// One stable jest.fn() pinned as getCommunityReconcileClient()'s return value
// (see beforeEach below) so every call site in the controller/gRPC handler
// resolves the SAME mock — otherwise the mock factory's `() => ({...})`
// would hand back a fresh object (and a fresh inner jest.fn()) per call,
// making call-count/ordering assertions impossible.
const updateReactionActivity = jest.fn(async () => true);

const ROOM = "room-1"; // GeneralRoom.id === communityId for community chat
const MSG = "msg-c1";
const TARGET_OWNER = "owner-1";
const BASE = "/api/chat/community";

let app: import("express").Express;
let mocks: BuiltMocks;

/** Resolves fetchMembers/resolveOverrides so assertions can inspect who the
 *  live bump actually reaches (both are functions, not plain values). */
async function resolveBump(call: Record<string, unknown>) {
  const fetchMembers = call.fetchMembers as () => Promise<string[]>;
  const recipients = await fetchMembers();
  const resolveOverrides = call.resolveOverrides as
    | ((ids: string[]) => Promise<Map<string, unknown>>)
    | undefined;
  const overrides = resolveOverrides
    ? await resolveOverrides(recipients)
    : new Map();
  return { recipients, overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  updateReactionActivity.mockClear().mockResolvedValue(true);
  reconcileClient.mockReturnValue({
    listCommunities: jest.fn(),
    updateReactionActivity,
  });
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
    new Map([
      [TEST_USER_ID, { displayName: "Reactor", avatar: "" }],
      [TARGET_OWNER, { displayName: "Owner", avatar: "" }],
    ])
  );
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    status: "active",
    role: "member",
  });
});

describe("REST POST /messages/:messageId/react — add: self-reaction", () => {
  it("publishes reaction_added with NO target — only the actor is a privileged viewer", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      senderName: "Reactor",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Hello",
      attachments: [],
      reactions: {},
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "👍" });

    expect(res.status).toBe(200);
    expect(pubActivity).toHaveBeenCalledTimes(1);
    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      communityId: ROOM,
      lastMessageId: MSG,
      type: "reaction_added",
      reactionMessageId: MSG,
      reactionEmoji: "👍",
      reactionActorId: TEST_USER_ID,
      reactionActorPreview: 'You reacted 👍 to "Hello"',
      reactionTargetId: null,
      reactionTargetPreview: null,
    });
    // Canonical fields are NOT part of this event's meaning.
    expect(pubActivity.mock.calls[0][0].messagePreview).toBe("");

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    const call = pubUpdated.mock.calls[0][0];
    expect(call.subjectUserId).toBe(TEST_USER_ID);
    expect(call.selfPreview).toBe('You reacted 👍 to "Hello"');
    const { recipients } = await resolveBump(call);
    // ONLY the actor — never the full membership.
    expect(recipients).toEqual([TEST_USER_ID]);
  });
});

describe("REST POST /messages/:messageId/react — add: cross-user reaction", () => {
  it("publishes reaction_added with a target, and the live bump reaches ONLY actor+target", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {},
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "❤️" });

    expect(res.status).toBe(200);
    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_added",
      reactionActorId: TEST_USER_ID,
      reactionActorPreview: 'You reacted ❤️ to "Let\'s meet at 5 PM"',
      reactionTargetId: TARGET_OWNER,
      reactionTargetPreview: "Reactor reacted ❤️ to your message",
    });

    const call = pubUpdated.mock.calls[0][0];
    const { recipients, overrides } = await resolveBump(call);
    // ONLY the actor + the message owner — nobody else.
    expect(recipients.sort()).toEqual([TARGET_OWNER, TEST_USER_ID].sort());
    // Actor sees their own text via subjectUserId/selfPreview.
    expect(call.subjectUserId).toBe(TEST_USER_ID);
    expect(call.selfPreview).toBe('You reacted ❤️ to "Let\'s meet at 5 PM"');
    // Target sees THEIR OWN text via the per-recipient override, not the actor's.
    const targetOverride = overrides.get(TARGET_OWNER) as {
      preview: { text: string };
    };
    expect(targetOverride.preview.text).toBe(
      "Reactor reacted ❤️ to your message"
    );
  });

  it("the recipient list has exactly 2 entries for a cross-user reaction", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Hi",
      attachments: [],
      reactions: {},
    });

    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "👍" });

    const { recipients } = await resolveBump(pubUpdated.mock.calls[0][0]);
    expect(recipients).toHaveLength(2);
  });
});

describe("REST POST /messages/:messageId/react — content-preview variations", () => {
  it("TEXT: long body is truncated + quoted (reaction-line length)", async () => {
    const longText =
      "This is a very long message body that definitely exceeds forty characters";
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: longText,
      attachments: [],
      reactions: {},
    });

    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });

    const expectedQuoted = `"${longText.slice(0, 40).trimEnd()}..."`;
    expect(pubActivity.mock.calls[0][0].reactionActorPreview).toBe(
      `You reacted 🔥 to ${expectedQuoted}`
    );
  });

  it("IMAGE: reuses the generic media label (no quotes)", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "IMAGE",
      message: "",
      attachments: [{ objectKey: "img.png", name: "img.png" }],
      reactions: {},
    });

    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "❤️" });

    expect(pubActivity.mock.calls[0][0].reactionActorPreview).toBe(
      "You reacted ❤️ to 📷 Photo"
    );
  });

  it("changing to a different emoji is treated as a fresh add for that bucket", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "❤️" });

    expect(res.status).toBe(200);
    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_added",
      reactionEmoji: "❤️",
    });
  });
});

describe("REST POST /messages/:messageId/react — remove", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("always fires reaction_removed with the identity triple, regardless of other reactions", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();

    expect(res.status).toBe(200);
    expect(pubActivity).toHaveBeenCalledTimes(1);
    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      communityId: ROOM,
      type: "reaction_removed",
      reactionMessageId: MSG,
      reactionEmoji: "🔥",
      reactionActorId: TEST_USER_ID,
    });
    // Never the canonical bump — removal is never "type: message" from here;
    // that decision lives entirely in community-service's identity match.
    expect(pubActivity.mock.calls[0][0].type).not.toBe("message");
  });

  it("live nudge refreshes actor + target to the room's real latest activity", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: "real-msg-1",
      roomId: ROOM,
      sentBy: "someone-else",
      senderName: "Someone",
      messageType: "TEXT",
      message: "The actual latest real message",
      attachments: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    const call = pubUpdated.mock.calls[0][0];
    expect(call.preview).toMatchObject({
      contentType: "TEXT",
      text: "The actual latest real message",
    });
    const { recipients } = await resolveBump(call);
    expect(recipients.sort()).toEqual([TARGET_OWNER, TEST_USER_ID].sort());
  });

  it("REGRESSION: the live nudge's lastMessageAt is a fresh timestamp, NOT the reverted message's own (older) createdAt — a client that only applies a bump when it's newer than what it already has would otherwise silently drop this update and leave the removed reaction stuck on screen", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    const staleCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: "real-msg-1",
      roomId: ROOM,
      sentBy: "someone-else",
      senderName: "Someone",
      messageType: "TEXT",
      message: "The actual latest real message",
      attachments: [],
      createdAt: staleCreatedAt,
    });

    const before = Date.now();
    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();
    const after = Date.now();

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    const call = pubUpdated.mock.calls[0][0];
    // The top-level lastMessageAt driving the bump must be "now", not the
    // stale message's own createdAt from 2020.
    expect(call.lastMessageAt).toBeGreaterThanOrEqual(before);
    expect(call.lastMessageAt).toBeLessThanOrEqual(after);
    expect(call.lastMessageAt).not.toBe(staleCreatedAt.getTime());

    // Every recipient's resolved override must also carry the fresh
    // timestamp — the actual value read at publish time.
    const { recipients, overrides } = await resolveBump(call);
    for (const id of recipients) {
      const override = overrides.get(id) as { lastMessageAt: number };
      expect(override.lastMessageAt).toBeGreaterThanOrEqual(before);
      expect(override.lastMessageAt).toBeLessThanOrEqual(after);
    }
  });

  it("REGRESSION: the live nudge never marks the reverted content unread — it is a revert of already-seen content, not a new message", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: "real-msg-1",
      roomId: ROOM,
      // Sender differs from the reactor — without the fix this makes the
      // plain (non-override) unread computation `memberId !== senderId` = true.
      sentBy: "someone-else",
      senderName: "Someone",
      messageType: "TEXT",
      message: "The actual latest real message",
      attachments: [],
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();

    const call = pubUpdated.mock.calls[0][0];
    const { recipients, overrides } = await resolveBump(call);
    expect(recipients).toContain(TEST_USER_ID);
    // resolveOverrides being present at all is what forces `unread:false` in
    // publishCommunityUpdated's override branch — assert it's actually wired.
    expect(overrides.has(TEST_USER_ID)).toBe(true);
  });

  it("no real message remains in the room → the live nudge is skipped, but reaction_removed still fires", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue(
      null
    );

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();

    expect(res.status).toBe(200);
    expect(pubActivity).toHaveBeenCalledTimes(1); // reaction_removed still fires
    expect(pubActivity.mock.calls[0][0].type).toBe("reaction_removed");
    expect(pubUpdated).not.toHaveBeenCalled(); // no live nudge without real data
  });

  it("consecutive add → remove: add fires reaction_added, remove fires reaction_removed for the SAME identity", async () => {
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    mocks.generalRoomMessageRepo.findById.mockResolvedValueOnce({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {},
    });
    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();
    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_added",
      reactionEmoji: "🔥",
      reactionActorId: TEST_USER_ID,
    });

    mocks.generalRoomMessageRepo.findById.mockResolvedValueOnce({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });
    await flush();

    expect(pubActivity).toHaveBeenCalledTimes(2);
    expect(pubActivity.mock.calls[1][0]).toMatchObject({
      type: "reaction_removed",
      reactionEmoji: "🔥",
      reactionActorId: TEST_USER_ID,
    });
  });
});

describe("gRPC reactToCommunityMessage — add/remove parity with REST", () => {
  type Handler = (
    call: { request: unknown },
    cb: (err: unknown, res?: unknown) => void
  ) => void;

  function invoke(handler: Handler, req: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      handler({ request: req }, (err, res) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(res)
      );
    });
  }

  function makeDeps(over: Record<string, unknown>): GrpcDeps {
    return over as unknown as GrpcDeps;
  }

  it("added:true, self-reaction → reaction_added with no target, live bump to actor only", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: true,
          actorName: "Reactor",
          targetUserId: TEST_USER_ID, // self-reaction
          targetMessagePreview: '"Hello"',
        })),
      },
    });

    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "👍",
    });

    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_added",
      reactionActorId: TEST_USER_ID,
      reactionTargetId: null,
      reactionTargetPreview: null,
    });
    const call = pubUpdated.mock.calls[0][0];
    const { recipients } = await resolveBump(call);
    expect(recipients).toEqual([TEST_USER_ID]);
  });

  it("added:true, cross-reaction → reaction_added with target, live bump to both", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: true,
          actorName: "Reactor",
          targetUserId: TARGET_OWNER,
          targetMessagePreview: '"Let\'s meet at 5 PM"',
        })),
      },
    });

    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "🔥",
    });

    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_added",
      reactionActorId: TEST_USER_ID,
      reactionTargetId: TARGET_OWNER,
    });
    const { recipients, overrides } = await resolveBump(
      pubUpdated.mock.calls[0][0]
    );
    expect(recipients.sort()).toEqual([TARGET_OWNER, TEST_USER_ID].sort());
    expect(overrides.has(TARGET_OWNER)).toBe(true);
  });

  it("added:false → reaction_removed + live nudge from getLatestRealActivityForLiveBump", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: false,
          actorName: "Reactor",
          targetUserId: TARGET_OWNER,
          targetMessagePreview: '"Let\'s meet at 5 PM"',
        })),
        getLatestRealActivityForLiveBump: jest.fn(async () => ({
          prevMessageId: "real-msg-1",
          preview: "The actual latest real message",
          messageType: "TEXT",
          sentBy: "someone-else",
          senderName: "Someone",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          hasLastMessage: true,
        })),
      },
    });

    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "🔥",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pubActivity.mock.calls[0][0]).toMatchObject({
      type: "reaction_removed",
      reactionMessageId: MSG,
      reactionEmoji: "🔥",
      reactionActorId: TEST_USER_ID,
    });
    expect(pubUpdated).toHaveBeenCalledTimes(1);
    expect(pubUpdated.mock.calls[0][0].preview).toMatchObject({
      contentType: "TEXT",
      text: "The actual latest real message",
    });
  });

  it("REGRESSION: gRPC remove path also uses a fresh lastMessageAt (not the reverted message's stale createdAt) and wires resolveOverrides so unread never gets forced true", async () => {
    const staleCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: false,
          actorName: "Reactor",
          targetUserId: TARGET_OWNER,
          targetMessagePreview: '"Let\'s meet at 5 PM"',
        })),
        getLatestRealActivityForLiveBump: jest.fn(async () => ({
          prevMessageId: "real-msg-1",
          preview: "The actual latest real message",
          messageType: "TEXT",
          sentBy: "someone-else",
          senderName: "Someone",
          createdAt: staleCreatedAt,
          hasLastMessage: true,
        })),
      },
    });

    const before = Date.now();
    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "🔥",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const after = Date.now();

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    const call = pubUpdated.mock.calls[0][0];
    expect(call.lastMessageAt).toBeGreaterThanOrEqual(before);
    expect(call.lastMessageAt).toBeLessThanOrEqual(after);
    expect(call.lastMessageAt).not.toBe(staleCreatedAt.getTime());

    const { recipients, overrides } = await resolveBump(call);
    expect(recipients.sort()).toEqual([TARGET_OWNER, TEST_USER_ID].sort());
    for (const id of recipients) {
      expect(overrides.has(id)).toBe(true);
    }
  });
});

describe("REST POST /messages/:messageId/react — synchronous persistence (reload-race fix)", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("REGRESSION: ADD awaits community-service's synchronous updateReactionActivity BEFORE the response returns — a client that reloads immediately after this response cannot race ahead of the DB write", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Hello",
      attachments: [],
      reactions: {},
    });

    let resolvedBeforeResponse = false;
    updateReactionActivity.mockImplementation(async () => {
      await flush();
      resolvedBeforeResponse = true;
      return true;
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "👍" });

    expect(res.status).toBe(200);
    // By the time supertest's promise resolves, the awaited call inside the
    // handler must have already settled — proving the response was NOT sent
    // ahead of the synchronous persistence call.
    expect(resolvedBeforeResponse).toBe(true);

    expect(updateReactionActivity).toHaveBeenCalledTimes(1);
    expect(updateReactionActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      added: true,
      messageId: MSG,
      emoji: "👍",
      actorId: TEST_USER_ID,
      actorPreview: 'You reacted 👍 to "Hello"',
      targetId: TARGET_OWNER,
      targetPreview: "Reactor reacted 👍 to your message",
      reactedAt: expect.any(Number),
    });
  });

  it("REGRESSION: REMOVE awaits community-service's synchronous updateReactionActivity BEFORE the response returns", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Hello",
      attachments: [],
      reactions: {
        "🔥": [{ userId: TEST_USER_ID, userName: "Reactor", avatar: "" }],
      },
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue(
      null
    );

    let resolvedBeforeResponse = false;
    updateReactionActivity.mockImplementation(async () => {
      await flush();
      resolvedBeforeResponse = true;
      return true;
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });

    expect(res.status).toBe(200);
    expect(resolvedBeforeResponse).toBe(true);
    expect(updateReactionActivity).toHaveBeenCalledTimes(1);
    expect(updateReactionActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      added: false,
      messageId: MSG,
      emoji: "🔥",
      actorId: TEST_USER_ID,
    });
  });

  it("fail-soft: the reaction still succeeds (200) when community-service's synchronous call fails — the async queue publish remains the backstop", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "TEXT",
      message: "Hello",
      attachments: [],
      reactions: {},
    });
    updateReactionActivity.mockResolvedValue(false);

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "👍" });

    expect(res.status).toBe(200);
    // The async backstop must still fire regardless of the sync call's outcome.
    expect(pubActivity).toHaveBeenCalledTimes(1);
    expect(pubActivity.mock.calls[0][0].type).toBe("reaction_added");
  });
});

describe("gRPC reactToCommunityMessage — synchronous persistence (reload-race fix)", () => {
  type Handler = (
    call: { request: unknown },
    cb: (err: unknown, res?: unknown) => void
  ) => void;

  function invoke(handler: Handler, req: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      handler({ request: req }, (err, res) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(res)
      );
    });
  }

  function makeDeps(over: Record<string, unknown>): GrpcDeps {
    return over as unknown as GrpcDeps;
  }

  it("REGRESSION: ADD awaits updateReactionActivity BEFORE the gRPC callback ack fires", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: true,
          actorName: "Reactor",
          targetUserId: TARGET_OWNER,
          targetMessagePreview: '"Hello"',
        })),
      },
    });

    let resolvedBeforeAck = false;
    updateReactionActivity.mockImplementation(async () => {
      await new Promise((r) => setImmediate(r));
      resolvedBeforeAck = true;
      return true;
    });

    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "👍",
    });

    expect(resolvedBeforeAck).toBe(true);
    expect(updateReactionActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        added: true,
        messageId: MSG,
        emoji: "👍",
        actorId: TEST_USER_ID,
      })
    );
  });

  it("REGRESSION: REMOVE awaits updateReactionActivity BEFORE the gRPC callback ack fires", async () => {
    const deps = makeDeps({
      communityMessageService: {
        reactToMessage: jest.fn(async () => ({
          messageId: MSG,
          roomId: ROOM,
          reactions: [],
          added: false,
          actorName: "Reactor",
          targetUserId: TARGET_OWNER,
          targetMessagePreview: '"Hello"',
        })),
        getLatestRealActivityForLiveBump: jest.fn(async () => ({
          hasLastMessage: false,
        })),
      },
    });

    let resolvedBeforeAck = false;
    updateReactionActivity.mockImplementation(async () => {
      await new Promise((r) => setImmediate(r));
      resolvedBeforeAck = true;
      return true;
    });

    await invoke(createCommunityImpl(deps).reactToCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      emoji: "🔥",
    });

    expect(resolvedBeforeAck).toBe(true);
    expect(updateReactionActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        added: false,
        messageId: MSG,
        emoji: "🔥",
        actorId: TEST_USER_ID,
      })
    );
  });
});

describe("REST POST /messages/:messageId/react — deleted / unavailable messages", () => {
  it("404 + no bump when the message does not exist", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });

    expect(res.status).toBe(404);
    expect(pubUpdated).not.toHaveBeenCalled();
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("400 + no bump when the message was deleted for everyone", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: true,
      messageType: "TEXT",
      message: "Let's meet at 5 PM",
      reactions: {},
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });

    expect(res.status).toBe(400);
    expect(pubUpdated).not.toHaveBeenCalled();
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("400 + no bump when reacting to a SYSTEM message (immutable)", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TARGET_OWNER,
      senderName: "Owner",
      deletedForAll: false,
      messageType: "SYSTEM",
      message: "John Doe joined the community",
      reactions: {},
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "🔥" });

    expect(res.status).toBe(400);
    expect(pubUpdated).not.toHaveBeenCalled();
    expect(pubActivity).not.toHaveBeenCalled();
  });
});

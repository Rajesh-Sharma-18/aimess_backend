/**
 * Delete-message lastActivity coverage — the fix for "GET /communities/mine
 * returns stale lastActivity after a community message delete".
 *
 * Root cause (see investigation): reactToMessage awaits a SYNCHRONOUS
 * companion RPC (`getCommunityReconcileClient().updateReactionActivity`)
 * BEFORE acking/responding, guaranteeing community-service's DB write lands
 * before the client can re-fetch. Delete had no equivalent — it only fired
 * the best-effort async `community.activity.queue` publish, and did so
 * AFTER the ack/response in gRPC, or fully detached (`void ... .then()`,
 * never awaited by the request handler at all) in REST.
 *
 * Fix: both delete-for-everyone and delete-for-me now await a new
 * `getCommunityReconcileClient().updateMessageActivity(...)` call — mirroring
 * updateReactionActivity's contract exactly — BEFORE the response/ack.
 *   - forEveryone: canonical bump (same fields as the async queue publish).
 *   - forMe: personal self-hide overlay (`selfUserId`/`selfPreview`) — the
 *     ONLY path that persists this, since the async queue never carries it
 *     and the canonical `lastActivity*` columns must stay untouched for
 *     every other member.
 */

// All jest.mock() hoisting must happen before any imports.
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
// Overrides the global stub (tests/setup/global-mocks.ts) with a STABLE mock
// object so call-order/call-count assertions work across the multiple
// getCommunityReconcileClient() call sites (REST controller + gRPC handler).
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: jest.fn(() => ({
    listCommunities: jest.fn(async () => ({
      communities: [],
      nextAfterId: "",
      hasMore: false,
    })),
    updateReactionActivity: jest.fn(async () => true),
    updateMessageActivity: jest.fn(async () => true),
  })),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { publishCommunityActivitySafe } from "../../src/events/publish-community-activity.js";
import { publishCommunityUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

const pubActivity = publishCommunityActivitySafe as jest.Mock;
const pubCommunityUpdated = publishCommunityUpdatedSafe as jest.Mock;
const reconcileClient = getCommunityReconcileClient as jest.Mock;
const updateMessageActivity = jest.fn(async () => true);

const ROOM = "room-1";
const MSG = "msg-c1";
const BASE = "/api/chat/community";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  jest.clearAllMocks();
  updateMessageActivity.mockClear().mockResolvedValue(true);
  reconcileClient.mockReturnValue({
    listCommunities: jest.fn(),
    updateReactionActivity: jest.fn(async () => true),
    updateMessageActivity,
  });
  ({ app, mocks } = buildApp());
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    status: "active",
    role: "member",
  });
});

describe("REST DELETE /messages/:messageId?type=forEveryone", () => {
  it("awaits updateMessageActivity (canonical bump) BEFORE the response resolves", async () => {
    const order: string[] = [];
    updateMessageActivity.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("updateMessageActivity");
      return true;
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
    });
    mocks.generalRoomMessageRepo.deleteForAll.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      createdAt: new Date(),
    });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({
      id: ROOM,
      status: "active",
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: "prev-1",
      sentBy: "sender-2",
      senderName: "Prev Sender",
      message: "",
      messageType: "IMAGE",
      createdAt: new Date(),
    });

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));
    order.push("response");

    expect(res.status).toBe(200);
    expect(order).toEqual(["updateMessageActivity", "response"]);
    expect(updateMessageActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        lastMessageId: "prev-1",
        senderUserId: "sender-2",
        senderUsername: "Prev Sender",
        messagePreview: "📷 Photo",
        activityType: "message",
      })
    );
    // The async queue publish remains the backstop, alongside the sync call.
    expect(pubActivity).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: ROOM, type: "message" })
    );
  });

  it("does NOT call updateMessageActivity when the deleted message wasn't the room's last (recalc === null)", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
    });
    mocks.generalRoomMessageRepo.deleteForAll.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      createdAt: new Date(),
    });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({
      id: ROOM,
      status: "active",
      lastMessageId: "some-other-message",
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue({
      id: "some-other-message",
      sentBy: "u",
      messageType: "text",
      createdAt: new Date(),
    });

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(updateMessageActivity).not.toHaveBeenCalled();
  });

  it("clears updateMessageActivity when the room becomes empty (hasLastMessage: false)", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
    });
    mocks.generalRoomMessageRepo.deleteForAll.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      createdAt: new Date(),
    });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({
      id: ROOM,
      status: "active",
    });
    // No previous visible message — room is now empty from this delete.
    mocks.generalRoomMessageRepo.findPreviousVisibleMessage.mockResolvedValue(
      null
    );

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      lastMessageAt: expect.any(Number),
      lastMessageId: "",
      senderUserId: "",
      senderUsername: "",
      messagePreview: "",
      activityType: "message",
    });
    expect(pubCommunityUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        lastMessageId: "",
        lastMessageAt: expect.any(Number),
      })
    );
    expect(
      pubCommunityUpdated.mock.calls.at(-1)?.[0].lastMessageAt
    ).toBeGreaterThan(0);
  });
});

describe("REST DELETE /messages/:messageId?type=forMe", () => {
  it("awaits updateMessageActivity with the personal self-hide overlay (selfUserId/selfPreview), never the canonical fields", async () => {
    const order: string[] = [];
    updateMessageActivity.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("updateMessageActivity");
      return true;
    });
    const deletedCreatedAt = new Date("2026-07-01T10:00:00.000Z");
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: "someone-else",
      messageType: "text",
      deletedForAll: false,
    });
    mocks.generalRoomMessageRepo.deleteForUser.mockResolvedValue(undefined);
    mocks.generalRoomMessageRepo.findById.mockResolvedValueOnce({
      id: MSG,
      roomId: ROOM,
      sentBy: "someone-else",
      messageType: "text",
      deletedForAll: false,
    });
    // deleteForMe re-reads the message after hiding it (per the service impl).
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: "someone-else",
      messageType: "text",
      deletedForAll: false,
      createdAt: deletedCreatedAt,
    });
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({
      id: ROOM,
      status: "active",
    });
    mocks.generalRoomMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "prev-2",
      sentBy: "sender-3",
      senderName: "Prev Sender 2",
      message: "",
      messageType: "DOCUMENT",
      attachments: [{ name: "guide.pdf" }],
      createdAt: new Date(deletedCreatedAt.getTime() - 1000),
    });

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forMe`)
      .set(bearer(makeAccessToken()));
    order.push("response");

    expect(res.status).toBe(200);
    expect(order).toEqual(["updateMessageActivity", "response"]);
    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      selfUserId: TEST_USER_ID,
      selfPreview: "📄 guide.pdf",
    });
    // Delete-for-me must NEVER touch the canonical bump.
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("does NOT call updateMessageActivity when the hidden message wasn't the viewer's effective last", async () => {
    const oldCreatedAt = new Date("2026-06-01T10:00:00.000Z");
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: "someone-else",
      messageType: "text",
      deletedForAll: false,
      createdAt: oldCreatedAt,
    });
    mocks.generalRoomMessageRepo.deleteForUser.mockResolvedValue(undefined);
    mocks.generalRoomRepo.findRoomById.mockResolvedValue({
      id: ROOM,
      status: "active",
    });
    // A NEWER message is still visible to this viewer — the deleted one was
    // not their effective last, so this must be a no-op.
    mocks.generalRoomMessageRepo.findPreviousVisibleForUser.mockResolvedValue({
      id: "newer-1",
      sentBy: "sender-4",
      messageType: "text",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const res = await request(app)
      .delete(`${BASE}/messages/${MSG}?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(updateMessageActivity).not.toHaveBeenCalled();
  });
});

describe("gRPC deleteCommunityMessage — forEveryone", () => {
  function makeDeps(over: Record<string, unknown>): GrpcDeps {
    return over as unknown as GrpcDeps;
  }
  type Handler = (
    call: { request: unknown },
    cb: (err: unknown, res?: unknown) => void
  ) => void;
  function invoke(handler: Handler, request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      handler({ request }, (err, res) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(res)
      );
    });
  }

  it("awaits updateMessageActivity BEFORE the gRPC ack", async () => {
    const order: string[] = [];
    updateMessageActivity.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("updateMessageActivity");
      return true;
    });
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockResolvedValue({ id: MSG, roomId: ROOM, createdAt: new Date() }),
        recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue({
          prevMessageId: "prev-1",
          preview: "the previous message",
          messageType: "TEXT",
          sentBy: "sender-2",
          senderName: "Prev Sender",
          createdAt: new Date(),
          hasLastMessage: true,
        }),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await invoke(impl.deleteCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      deleteType: "forEveryone",
    });
    order.push("ack");

    expect(res).toMatchObject({ messageId: MSG, deleteType: "forEveryone" });
    expect(order).toEqual(["updateMessageActivity", "ack"]);
    expect(updateMessageActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM,
        lastMessageId: "prev-1",
        senderUserId: "sender-2",
        senderUsername: "Prev Sender",
        activityType: "message",
      })
    );
  });

  it("skips updateMessageActivity when recalc is null (deleted message wasn't the room's last)", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockResolvedValue({ id: MSG, roomId: ROOM, createdAt: new Date() }),
        recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue(null),
      },
    });
    const impl = createCommunityImpl(deps);
    await invoke(impl.deleteCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      deleteType: "forEveryone",
    });
    expect(updateMessageActivity).not.toHaveBeenCalled();
  });

  it("clears updateMessageActivity when recalc has no last message", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForAll: jest
          .fn()
          .mockResolvedValue({ id: MSG, roomId: ROOM, createdAt: new Date() }),
        recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue({
          prevMessageId: null,
          preview: "",
          messageType: "",
          sentBy: "",
          senderName: "",
          createdAt: new Date(0),
          hasLastMessage: false,
        }),
      },
    });
    const impl = createCommunityImpl(deps);
    await invoke(impl.deleteCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      deleteType: "forEveryone",
    });
    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      lastMessageAt: expect.any(Number),
      lastMessageId: "",
      senderUserId: "",
      senderUsername: "",
      messagePreview: "",
      activityType: "message",
    });
  });
});

describe("gRPC deleteCommunityMessage — forMe", () => {
  function makeDeps(over: Record<string, unknown>): GrpcDeps {
    return over as unknown as GrpcDeps;
  }
  type Handler = (
    call: { request: unknown },
    cb: (err: unknown, res?: unknown) => void
  ) => void;
  function invoke(handler: Handler, request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      handler({ request }, (err, res) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(res)
      );
    });
  }

  it("awaits updateMessageActivity with the self-hide overlay BEFORE the gRPC ack", async () => {
    const order: string[] = [];
    updateMessageActivity.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("updateMessageActivity");
      return true;
    });
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockResolvedValue({ id: MSG, roomId: ROOM, createdAt: new Date() }),
        recalculateLastMessageAfterDeleteForMe: jest.fn().mockResolvedValue({
          prevMessageId: "prev-2",
          preview: "an earlier message",
          messageType: "TEXT",
          sentBy: "sender-3",
          senderName: "Prev Sender 2",
          createdAt: new Date(),
          hasLastMessage: true,
          wasEffectiveLast: true,
        }),
      },
    });
    const impl = createCommunityImpl(deps);
    const res = await invoke(impl.deleteCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      deleteType: "forMe",
    });
    order.push("ack");

    expect(res).toMatchObject({ messageId: MSG, deleteType: "forMe" });
    expect(order).toEqual(["updateMessageActivity", "ack"]);
    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: ROOM,
      selfUserId: TEST_USER_ID,
      selfPreview: "an earlier message",
    });
  });

  it("skips updateMessageActivity when the deleted message wasn't the viewer's effective last", async () => {
    const deps = makeDeps({
      communityMessageService: {
        deleteForMe: jest
          .fn()
          .mockResolvedValue({ id: MSG, roomId: ROOM, createdAt: new Date() }),
        recalculateLastMessageAfterDeleteForMe: jest.fn().mockResolvedValue({
          prevMessageId: "newer-1",
          preview: "",
          messageType: "TEXT",
          sentBy: "",
          senderName: "",
          createdAt: new Date(),
          hasLastMessage: true,
          wasEffectiveLast: false,
        }),
      },
    });
    const impl = createCommunityImpl(deps);
    await invoke(impl.deleteCommunityMessage as Handler, {
      messageId: MSG,
      communityId: ROOM,
      userId: TEST_USER_ID,
      deleteType: "forMe",
    });
    expect(updateMessageActivity).not.toHaveBeenCalled();
  });
});

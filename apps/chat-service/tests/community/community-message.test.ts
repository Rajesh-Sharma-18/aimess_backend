/**
 * Integration tests — community messages.
 * Routes (apps/chat-service/src/api/routes/community.routes.ts, mounted at /api/chat/community):
 *   GET    /rooms/:roomId/sync               (Zod: since_ts required)
 *   POST   /rooms/:roomId/messages/:messageId/pin   (Zod body; role-gated)
 *   DELETE /rooms/:roomId/messages/:messageId/pin   (Zod body: messageId)
 *   GET    /rooms/:roomId/messages/search
 *   GET    /rooms/:roomId/messages
 *   GET    /rooms/:roomId/conversation       (membership-gated)
 *   GET    /rooms/:roomId/media              (membership-gated)
 *   DELETE /messages/:messageId              (?type=forMe|forEveryone)
 *   PATCH  /messages/:messageId              (Zod body: communityId + content.text)
 *   POST   /messages/:messageId/react        (Zod body: communityId + emoji)
 *   GET    /rooms/:roomId/pins
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "room-1";
const BASE = "/api/chat/community";

/**
 * Role authorization for pin/unpin/delete-for-everyone-of-another's-message
 * is sourced LIVE from community-service (`checkCommunityMembership`), not
 * `RoomMember.role` — see access-guard.ts `assertCommunityRole`/
 * `getCommunityLiveRole`. The global mock (tests/setup/global-mocks.ts)
 * defaults this to ADMIN so most tests need no changes; a test that wants to
 * exercise a DENIED scenario must override the next `checkCommunityMembership`
 * call to return the intended (lower) role, mirroring whatever `RoomMember`
 * role it also mocks so the two stay obviously in sync for the reader.
 */
function mockLiveRole(role: "ADMIN" | "MODERATOR" | "MEMBER" | ""): void {
  (getCommunityReconcileClient as jest.Mock).mockReturnValueOnce({
    checkCommunityMembership: jest.fn(async () => ({
      isMember: role !== "",
      isBanned: false,
      status: role !== "" ? "ACTIVE" : "",
      role,
    })),
  });
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("GET /rooms/:roomId/messages (timeline + history)", () => {
  it("POSITIVE: returns the latest page (UPPER contentType wire shape)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          createdAt: new Date(1),
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(1);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].contentType).toBe("TEXT");
    // Per-message delivery/read receipts are no longer part of the history
    // wire — omit entirely (not null/[]).
    expect(res.body.data.data[0]).not.toHaveProperty("deliveredTo");
    expect(res.body.data.data[0]).not.toHaveProperty("readBy");
  });

  it("POSITIVE: history omits deliveredTo/readBy for every message type (TEXT/IMAGE/SYSTEM/reply)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m-text",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          createdAt: new Date(1),
        },
        {
          id: "m-image",
          roomId: ROOM,
          sentBy: "u",
          message: "",
          messageType: "image",
          attachments: [{ objectKey: "img/1.jpg", mime: "image/jpeg" }],
          createdAt: new Date(2),
        },
        {
          id: "m-sys",
          roomId: ROOM,
          sentBy: "",
          message: "Rajesh joined the community",
          messageType: "system",
          systemMessageType: "MEMBER_JOINED",
          createdAt: new Date(3),
        },
        {
          id: "m-reply",
          roomId: ROOM,
          sentBy: "u",
          message: "reply",
          messageType: "text",
          parentMessageId: "m-text",
          quoteData: {
            messageId: "m-text",
            senderId: "u",
            senderName: "U",
            messageType: "TEXT",
            preview: "hi",
          },
          createdAt: new Date(4),
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(4);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([
      {
        userId: "peer",
        lastReadAt: new Date(10),
        joinedAt: new Date(0),
      },
    ]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(4);
    for (const msg of res.body.data.data) {
      expect(msg).not.toHaveProperty("deliveredTo");
      expect(msg).not.toHaveProperty("readBy");
    }
    // Remaining fields stay intact across types (order is newest-first).
    const byId = Object.fromEntries(
      res.body.data.data.map((m: { id: string }) => [m.id, m])
    );
    expect(byId["m-text"].contentType).toBe("TEXT");
    expect(byId["m-image"].contentType).toBe("IMAGE");
    expect(byId["m-sys"].contentType).toBe("SYSTEM");
    expect(byId["m-reply"].parentMessageId).toBe("m-text");
    expect(res.body.data).toHaveProperty("pagination");
  });

  it("POSITIVE: pinnedMessage is null when the room has no active pin", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(0);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);
    mocks.communityMessagePinRepo.findActivePinByRoom.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.pinnedMessage).toBeNull();
  });

  it("POSITIVE: pinnedMessage carries the FE-header fields when a message is pinned, without touching the `messages` array shape", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          createdAt: new Date(1),
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(1);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const pinnedAt = new Date("2026-07-01T10:00:00.000Z");
    mocks.communityMessagePinRepo.findActivePinByRoom.mockResolvedValue({
      messageId: "pinned-1",
      roomId: ROOM,
      communityId: ROOM,
      pinnedBy: "mod-1",
      pinnedAt,
      unpinnedAt: null,
      originalMessageDeletedAt: null,
      messageCreatedAt: new Date("2026-06-30T09:00:00.000Z"),
      senderId: "sender-1",
      senderDisplayName: "",
      senderAvatar: "",
      contentPinned: { text: "", urls: [], files: [] },
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "pinned-1",
      roomId: ROOM,
      sentBy: "sender-1",
      senderName: "Pinned Sender",
      senderAvatar: "",
      message: "This is the pinned message",
      messageType: "text",
      attachments: [],
      deletedForAll: false,
      createdAt: new Date("2026-06-30T09:00:00.000Z"),
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    // Existing `messages` (`data`) array is unchanged — backward compatible.
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].id).toBe("m1");
    // New top-level field carries the pinned message.
    expect(res.body.data.pinnedMessage).toMatchObject({
      messageId: "pinned-1",
      roomId: ROOM,
      senderId: "sender-1",
      senderName: "Pinned Sender",
      messageType: "TEXT",
      text: "This is the pinned message",
      pinnedBy: "mod-1",
      pinnedAt: pinnedAt.getTime(),
      isAvailable: true,
    });
  });

  it("POSITIVE: messages are returned in ascending (oldest→newest) order", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    // Repository returns the page newest-first (DESC) as the DB would for a
    // before-direction keyset page. The service must reverse this before responding.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m3",
          roomId: ROOM,
          sentBy: "u",
          message: "newest",
          messageType: "text",
          createdAt: new Date(3000),
          deletedBy: [],
        },
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "middle",
          messageType: "text",
          createdAt: new Date(2000),
          deletedBy: [],
        },
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "oldest",
          messageType: "text",
          createdAt: new Date(1000),
          deletedBy: [],
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(3);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const items = res.body.data.data as Array<{ id: string }>;
    expect(items).toHaveLength(3);
    // Ascending: oldest (m1) first, newest (m3) last.
    expect(items[0].id).toBe("m1");
    expect(items[1].id).toBe("m2");
    expect(items[2].id).toBe("m3");
  });

  it("POSITIVE: nextCursor points to the oldest item (pagination boundary for next older page)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    // Repo returns the page (limit=2) newest-first plus an exact hasMore flag.
    // The DB now computes hasMore via over-fetch, so the service no longer slices.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m3",
          roomId: ROOM,
          sentBy: "u",
          message: "newest",
          messageType: "text",
          createdAt: new Date(3000),
          deletedBy: [],
        },
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "second",
          messageType: "text",
          createdAt: new Date(2000),
          deletedBy: [],
        },
      ],
      hasMore: true,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(10);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?limit=2`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const body = res.body.data as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string;
    };
    // Page returns [m2, m3] in ASC order.
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("m2");
    expect(body.data[1].id).toBe("m3");
    expect(body.hasMore).toBe(true);
    // nextCursor is a COMPOUND keyset "<oldest-in-page ms>_<id>" — fed back as
    // before_ts. The _id tiebreaker keeps same-millisecond messages reachable.
    expect(body.nextCursor).toBe("2000_m2");
  });

  it("POSITIVE: a compound before_ts ('<ms>_<id>') is parsed into the (ts, boundaryId) keyset", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(0);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const boundaryId = "a".repeat(24);
    const res = await request(app)
      .get(
        `${BASE}/rooms/${ROOM}/messages?before_ts=2000_${boundaryId}&limit=5`
      )
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const call =
      mocks.generalRoomMessageRepo.findByRoomIdTimeline.mock.calls[0][0];
    expect(call.boundaryId).toBe(boundaryId);
    expect(call.ts.getTime()).toBe(2000);
    expect(call.inclusive).toBe(false); // a cursor page is exclusive
  });

  // AUDIT H2 — the before_ts/latest history list must be gated on membership.
  it("SECURITY: IDOR — 403 reading history (latest/before_ts) as a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(
      mocks.generalRoomMessageRepo.findByRoomIdTimeline
    ).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // BAN-AS-READ-CUTOFF: a banned member no longer gets 403 on this endpoint
  // (history/scroll, sync, and jump-to-message modes) — the ban instead caps
  // the readable window at `bannedAt`. Every WRITE path (send/react/edit/
  // delete/pin/etc.) still throws USER_BANNED unconditionally — see the
  // "USER_BANNED" tests elsewhere in this file and in community-read-access.
  // ---------------------------------------------------------------------
  it("BAN-CUTOFF: a banned member gets 200 (not 403) on history/scroll, and the repo is called with readCutoff=bannedAt", async () => {
    const bannedAt = new Date("2026-07-01T10:11:00.000Z");
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
      bannedAt,
    });
    // The emulator/mock stands in for the DB filter; here we just assert the
    // service passes the cutoff through — the actual `createdAt <= readCutoff`
    // filtering is exercised against the real repo in community-read-access.test.ts.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "before the ban",
          messageType: "text",
          createdAt: new Date("2026-07-01T10:10:00.000Z"),
        },
      ],
      hasMore: false,
    });
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(1);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    const call =
      mocks.generalRoomMessageRepo.findByRoomIdTimeline.mock.calls[0][0];
    expect(call.readCutoff).toEqual(bannedAt);
    expect(call.viewerIsActiveMember).toBe(false);
  });

  it("BAN-CUTOFF: a banned member's incremental sync (after_ts) also gets 200 with readCutoff passed through", async () => {
    const bannedAt = new Date("2026-07-01T10:11:00.000Z");
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
      bannedAt,
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const call =
      mocks.generalRoomMessageRepo.findUpdatedAtSince.mock.calls[0][0];
    expect(call.readCutoff).toEqual(bannedAt);
  });

  it("BAN-CUTOFF: a banned member's jump-to-message (around) also gets 200 with readCutoff passed through", async () => {
    const bannedAt = new Date("2026-07-01T10:11:00.000Z");
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
      bannedAt,
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "anchor",
      roomId: ROOM,
      createdAt: new Date("2026-07-01T10:05:00.000Z"),
    });
    mocks.generalRoomMessageRepo.findAroundDate.mockResolvedValue([]);
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(0);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?around=anchor`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const call = mocks.generalRoomMessageRepo.findAroundDate.mock.calls[0][0];
    expect(call.readCutoff).toEqual(bannedAt);
  });

  it("POSITIVE: after_ts triggers incremental sync mode", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hi",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1000),
          updatedAt: new Date(1000),
          editedAt: null,
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].syncEventType).toBe("new");
    expect(res.body.data.data[0].isEdited).toBe(false);
  });

  it("POSITIVE: after_ts sync sets isEdited:true for messages with editedAt set", async () => {
    const editedTs = 2000;
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m2",
          roomId: ROOM,
          sentBy: "u",
          message: "hi edited",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1000),
          updatedAt: new Date(editedTs),
          editedAt: new Date(editedTs),
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].isEdited).toBe(true);
    expect(res.body.data.data[0].editedAt).toBe(editedTs);
  });

  it("SECURITY: 403 incremental-sync for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?after_ts=500`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when both before_ts and after_ts are provided", async () => {
    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?before_ts=1&after_ts=2`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/rooms/${ROOM}/messages`);
    expect(res.status).toBe(401);
  });

  // §5.1/§5.2 — community jump-to-message window: compound olderCursor for
  // before_ts, plain epoch-ms newerCursor for after_ts, + both-direction flags.
  it("POSITIVE: ?around= returns a window + bidirectional cursors (+ pinnedMessage)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m2",
      createdAt: new Date(2000),
    });
    mocks.generalRoomMessageRepo.findAroundDate.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "a",
        messageType: "text",
        createdAt: new Date(1000),
      },
      {
        id: "m2",
        roomId: ROOM,
        sentBy: "u",
        message: "b",
        messageType: "text",
        createdAt: new Date(2000),
      },
      {
        id: "m3",
        roomId: ROOM,
        sentBy: "u",
        message: "c",
        messageType: "text",
        createdAt: new Date(3000),
      },
    ]);
    mocks.roomMemberRepo.findReadStatusByRoom.mockResolvedValue([]);
    mocks.generalRoomMessageRepo.countTimeline.mockResolvedValue(5);
    // Older probe (before the first row) finds a row; newer probe finds none.
    mocks.generalRoomMessageRepo.findByRoomIdTimeline.mockImplementation(
      async ({ direction }: { direction: "before" | "after" }) => ({
        messages: direction === "before" ? [{ id: "m0" }] : [],
        hasMore: false,
      })
    );
    mocks.communityMessagePinRepo.findActivePinByRoom.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages?around=m2`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(3);
    expect(res.body.data.hasMoreOlder).toBe(true);
    expect(res.body.data.hasMoreNewer).toBe(false);
    expect(res.body.data.olderCursor).toBe("1000_m1"); // → before_ts (compound)
    expect(res.body.data.newerCursor).toBe("3000"); // → after_ts (epoch-ms)
    expect(res.body.data.pinnedMessage).toBeNull();
  });
});

describe("GET /rooms/:roomId/messages/search (membership-gated)", () => {
  it("POSITIVE: an active member can search", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.searchByText.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "hello",
          messageType: "text",
          createdAt: new Date(1),
        },
      ],
      scores: new Map(),
      hasMore: false,
      nextCursor: null,
    });
    mocks.generalRoomMessageRepo.countSearchResults.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  // Regression: `page` was parsed but never converted to a DB skip, so page 2
  // silently returned the exact same window as page 1 and any match beyond
  // the first `limit` results was unreachable.
  it("REGRESSION: forwards the keyset cursor, never a skip offset", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.searchByText.mockResolvedValue({
      messages: [],
      scores: new Map(),
      hasMore: false,
      nextCursor: null,
    });

    await request(app)
      .get(
        `${BASE}/rooms/${ROOM}/messages/search?q=hello&limit=10&cursor=1700000000000_abc`
      )
      .set(bearer(makeAccessToken()));

    const args = mocks.generalRoomMessageRepo.searchByText.mock.calls[0][0];
    expect(args).toMatchObject({
      roomId: ROOM,
      query: "hello",
      limit: 10,
      cursor: "1700000000000_abc",
    });
    expect(args).not.toHaveProperty("skip");
  });

  it("REGRESSION: surfaces hasMore/nextCursor so the client pages without duplicates", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.searchByText.mockResolvedValue({
      messages: [],
      scores: new Map(),
      hasMore: true,
      nextCursor: "1700000000000_abc",
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe("1700000000000_abc");
  });

  // AUDIT H2 — community search must be gated on active membership (IDOR).
  it("SECURITY: IDOR — 403 searching a community you're not a member of", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/messages/search?q=hello`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.generalRoomMessageRepo.searchByText).not.toHaveBeenCalled();
  });
});

describe("GET /rooms/:roomId/sync", () => {
  it("POSITIVE: returns messages since the cursor for an active member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.findUpdatedAtSince.mockResolvedValue({
      messages: [
        {
          id: "m1",
          roomId: ROOM,
          sentBy: "u",
          message: "x",
          messageType: "text",
          deletedForAll: false,
          createdAt: new Date(1),
          updatedAt: new Date(1),
          editedAt: null,
        },
      ],
      hasMore: false,
    });

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync?since_ts=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("NEGATIVE: 400 when since_ts is missing (required)", async () => {
    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(400);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/sync?since_ts=1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

describe("GET /rooms/:roomId/conversation (membership-gated)", () => {
  it("POSITIVE: active member gets the page", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.listConversationMessages.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "x",
        messageType: "text",
        createdAt: new Date(5),
      },
    ]);
    mocks.generalRoomMessageRepo.countConversation.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });

  it("BANNED (non-active) member: 200, page capped at bannedAt — no read-pointer write", async () => {
    const bannedAt = new Date(5);
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "banned",
      bannedAt,
    });
    mocks.generalRoomMessageRepo.listConversationMessages.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        message: "x",
        messageType: "text",
        createdAt: new Date(5),
      },
    ]);
    mocks.generalRoomMessageRepo.countConversation.mockResolvedValue(1);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/conversation`)
      .set(bearer(makeAccessToken()));

    // A ban is a READ CUTOFF, not a hard block: the community stays visible in
    // the banned member's LIST, and history up to (and including) their
    // bannedAt is still readable — a ban only revokes WRITE/realtime access.
    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(
      mocks.generalRoomMessageRepo.listConversationMessages
    ).toHaveBeenCalledWith(
      expect.objectContaining({ beforeMs: bannedAt.getTime() })
    );
    // Read state is a member-only concept — a banned viewer never advances
    // the read pointer, even on a successful capped read.
    expect(mocks.roomMemberRepo.advanceReadPointer).not.toHaveBeenCalled();
  });
});

describe("GET /rooms/:roomId/media (membership-gated)", () => {
  it("POSITIVE: active member lists media", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
    });
    mocks.generalRoomMessageRepo.listMedia.mockResolvedValue([
      {
        id: "m1",
        roomId: ROOM,
        sentBy: "u",
        messageType: "image",
        createdAt: new Date(1),
      },
    ]);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/media?type=IMAGE`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("SECURITY: 403 for a non-member", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
  });
});

describe("DELETE /messages/:messageId", () => {
  it("POSITIVE: forEveryone on own message + broadcasts deletion", async () => {
    mocks.generalRoomMessageRepo.findById
      .mockResolvedValueOnce({ id: "m1", sentBy: TEST_USER_ID, roomId: ROOM })
      .mockResolvedValue({
        id: "m1",
        roomId: ROOM,
        messageType: "text",
        deletedForAll: true,
      });
    // Room-bind guard: caller is an active member of the message's room.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });
    mocks.generalRoomMessageRepo.deleteForAll.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      messageType: "text",
    });

    const res = await request(app)
      .delete(`${BASE}/messages/m1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      `community:${ROOM}`,
      expect.stringContaining("community:message:deleted")
    );
  });

  it("SECURITY: 400 forEveryone on another user's message without a mod role", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      sentBy: "someone-else",
      roomId: ROOM,
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });
    // Role is authorized LIVE against community-service, not RoomMember.role —
    // the RoomMember mock above is status-only now; drive the actual denial
    // via the live-role lookup.
    mockLiveRole("MEMBER");

    const res = await request(app)
      .delete(`${BASE}/messages/m1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.generalRoomMessageRepo.deleteForAll).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 when the message is missing", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .delete(`${BASE}/messages/ghost?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
  });

  it("NEGATIVE: 400 forEveryone on a message already tombstoned for everyone", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      sentBy: TEST_USER_ID,
      roomId: ROOM,
      messageType: "text",
      deletedForAll: true,
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });

    const res = await request(app)
      .delete(`${BASE}/messages/m1?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(400);
    expect(mocks.generalRoomMessageRepo.deleteForAll).not.toHaveBeenCalled();
  });
});

describe("PATCH /messages/:messageId (edit)", () => {
  it("POSITIVE: edit own text message and broadcast", async () => {
    const now = Date.now();
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(now - 1000),
    });
    // Room-bind guard: caller is an active member of the message's room.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });
    mocks.generalRoomMessageRepo.editMessage.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      message: "edited",
      createdAt: new Date(now - 1000),
      editedAt: new Date(now),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "edited" } });

    expect(res.status).toBe(200);
    expect(res.body.data.isEdited).toBe(true);
    expect(res.body.data.editedAt).toBeGreaterThan(0);
    // After the cross-channel fix: broadcast goes to the message's OWN room
    // (result.roomId), NOT the body-supplied communityId ("comm-1").
    const publishCall = mocks.redis.publish.mock.calls.find(
      ([, payload]: [string, string]) => {
        try {
          return JSON.parse(payload).event === "community:message:edited";
        } catch {
          return false;
        }
      }
    );
    expect(publishCall).toBeDefined();
    const broadcastPayload = JSON.parse(publishCall[1]);
    expect(broadcastPayload.data.isEdited).toBe(true);
    expect(broadcastPayload.data.editedAt).toBeGreaterThan(0);
  });

  it("SECURITY: 400 editing another user's message", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      sentBy: "not-me",
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(),
    });
    // Member guard passes (caller is active in the message's room), so the
    // own-only sender check is what rejects with 400 — not the room-bind 404.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      role: "member",
      status: "active",
    });

    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "hax" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when communityId is missing from body", async () => {
    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "edited" } });

    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 400 when content.text is empty", async () => {
    const res = await request(app)
      .patch(`${BASE}/messages/m1`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", content: { text: "" } });

    expect(res.status).toBe(400);
  });
});

describe("POST /messages/:messageId/react", () => {
  it("POSITIVE: toggles a reaction for an active member", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", emoji: "👍" });

    expect(res.status).toBe(200);
    expect(mocks.generalRoomMessageRepo.updateById).toHaveBeenCalled();
  });

  it("SECURITY: 403 reacting as a non-member", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1", emoji: "👍" });

    expect(res.status).toBe(403);
  });

  it("NEGATIVE: 400 when emoji is missing", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/m1/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: "comm-1" });

    expect(res.status).toBe(400);
  });
});

describe("pins: POST pin + DELETE unpin + GET list", () => {
  it("POSITIVE: a moderator pins a message and broadcasts", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "moderator",
    });
    mocks.communityMessagePinRepo.countPinsByRoom.mockResolvedValue(0);
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      message: "pin",
      createdAt: new Date(1),
    });
    mocks.communityMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.generalRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(200);
    expect(mocks.redis.publish).toHaveBeenCalledWith(
      "community:comm-1",
      expect.stringContaining("community:message:pinned")
    );
  });

  it("POSITIVE: pinning a different message auto-unpins the previous one (single active pin invariant)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "moderator",
    });
    // An active pin already exists on a DIFFERENT message.
    mocks.communityMessagePinRepo.findActivePinByRoom.mockResolvedValue({
      id: "pin-old",
      messageId: "m-old",
      roomId: ROOM,
      unpinnedAt: null,
    });
    mocks.communityMessagePinRepo.softDeletePin.mockResolvedValue({
      id: "pin-old",
      messageId: "m-old",
      roomId: ROOM,
      unpinnedAt: new Date(3),
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m-new",
      roomId: ROOM,
      message: "new pin",
      createdAt: new Date(1),
    });
    mocks.communityMessagePinRepo.createPin.mockResolvedValue({
      id: "pin-new",
      messageId: "m-new",
      pinnedAt: new Date(2),
    });
    mocks.generalRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m-new/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m-new", communityId: "comm-1" });

    expect(res.status).toBe(200);
    // Reuses the existing repository methods — no duplicated business logic.
    expect(mocks.communityMessagePinRepo.softDeletePin).toHaveBeenCalledWith(
      "pin-old",
      TEST_USER_ID,
      expect.any(Date),
      expect.anything()
    );
    expect(mocks.communityMessagePinRepo.createPin).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-new" }),
      expect.anything()
    );
    // Both realtime events are published: the previous pin's UNPIN first,
    // then the new PIN — never leaving two pins visible at once.
    const events = mocks.redis.publish.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[1] as string).event
    );
    expect(events).toEqual([
      "community:message:unpinned",
      "community:message:pinned",
    ]);
  });

  it("POSITIVE: re-pinning the currently-active message is an idempotent no-op (no duplicate record, no events)", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "moderator",
    });
    mocks.communityMessagePinRepo.findActivePinByRoom.mockResolvedValue({
      id: "pin1",
      messageId: "m1",
      roomId: ROOM,
      unpinnedAt: null,
    });
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      message: "already pinned",
      createdAt: new Date(1),
    });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(200);
    expect(mocks.communityMessagePinRepo.createPin).not.toHaveBeenCalled();
    expect(mocks.communityMessagePinRepo.softDeletePin).not.toHaveBeenCalled();
    expect(mocks.redis.publish).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when a plain member tries to pin", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });
    // Role is authorized LIVE against community-service, not RoomMember.role.
    mockLiveRole("MEMBER");

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(403);
  });

  it("SECURITY: 403 when a plain member tries to unpin", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });
    // Role is authorized LIVE against community-service, not RoomMember.role.
    mockLiveRole("MEMBER");

    const res = await request(app)
      .delete(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1" });

    expect(res.status).toBe(403);
    expect(mocks.communityMessagePinRepo.softDeletePin).not.toHaveBeenCalled();
  });

  it('POSITIVE: an admin can pin even when RoomMember.role is stale ("member") — proves community-service role is authoritative', async () => {
    // The whole point of the fix: a stale/lagging RoomMember.role must NOT
    // block (or wrongly allow) an action once community-service disagrees.
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member", // stale local mirror — actually an ADMIN in community-service
    });
    mockLiveRole("ADMIN");
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
      message: "pin me",
      createdAt: new Date(1),
    });
    mocks.communityMessagePinRepo.createPin.mockResolvedValue({
      id: "pin1",
      pinnedAt: new Date(2),
    });
    mocks.generalRoomRepo.incPinnedCount.mockResolvedValue({ pinnedCount: 1 });

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(200);
  });

  it('SECURITY: a stale RoomMember.role of "moderator" no longer authorizes pin once community-service says MEMBER (demotion took effect)', async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "moderator", // stale local mirror — community-service already demoted them
    });
    mockLiveRole("MEMBER");

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(403);
    expect(mocks.communityMessagePinRepo.createPin).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 pinning when not a member of the room", async () => {
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: "m1", communityId: "comm-1" });

    expect(res.status).toBe(404);
  });

  it("POSITIVE: lists pins for a room", async () => {
    mocks.communityMessagePinRepo.findPinsByRoom.mockResolvedValue([
      { id: "pin1", pinnedAt: new Date(1) },
    ]);
    // Nothing hidden by delete-for-me for this viewer.
    mocks.generalRoomMessageRepo.findHiddenIdsForUser.mockResolvedValue(
      new Set()
    );

    const res = await request(app)
      .get(`${BASE}/rooms/${ROOM}/pins`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("NEGATIVE: 400 unpin missing required body messageId", async () => {
    // DELETE /rooms/:roomId/messages/:messageId/pin validates body messageId.
    const res = await request(app)
      .delete(`${BASE}/rooms/${ROOM}/messages/m1/pin`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
  });
});

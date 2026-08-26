/**
 * Group join limits — capacity (256), the rejoin block, and link revocation.
 *
 * Every scenario id below maps to GROUP_JOIN_LIMITS_VERIFICATION_REPORT.md.
 * The three behaviours share ONE decision function
 * (`src/lib/group-invite-state.ts`), so the unit block pins the priority table
 * and the API blocks prove each surface actually consults it.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { resolveGroupInviteState } from "../../src/lib/group-invite-state.js";
import { MAX_GROUP_MEMBERS } from "@aimess/constants";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const TOKEN = "tok-1234567890";
const OTHER = "44444444-4444-4444-8444-444444444444";

const liveLink = {
  token: TOKEN,
  roomId: ROOM,
  createdBy: OTHER,
  status: "ACTIVE",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  maxUses: null,
  usedCount: 0,
  shareName: "",
};

const roomAt = (memberCount: number, memberLimit = MAX_GROUP_MEMBERS) => ({
  roomId: ROOM,
  name: "Devs",
  avatar: "",
  description: "",
  status: "ACTIVE",
  memberCount,
  memberLimit,
  settings: {},
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(liveLink);
  mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(liveLink);
  mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(3));
  mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
  mocks.groupMemberRepo.upsert.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    role: "MEMBER",
    joinedAt: new Date(),
  });
});

const preview = (auth = true) => {
  const req = request(app).get(`/api/chat/invite-links/preview/${TOKEN}`);
  return auth ? req.set(bearer(makeAccessToken())) : req;
};

const join = () =>
  request(app)
    .post("/api/chat/invite-links/join")
    .set(bearer(makeAccessToken()))
    .send({ token: TOKEN });

// ---------------------------------------------------------------------------
// The state machine itself — one table, one priority order.
// ---------------------------------------------------------------------------
describe("resolveGroupInviteState — priority table", () => {
  const base = {
    room: { memberCount: 3, memberLimit: MAX_GROUP_MEMBERS },
    link: { status: "ACTIVE", expiresAt: null, maxUses: null, usedCount: 0 },
    membership: null as { status?: string } | null,
    hasToken: true,
  };

  it("a member wins over every other condition — a full group still opens", () => {
    expect(
      resolveGroupInviteState({
        ...base,
        room: { memberCount: 256, memberLimit: 256 },
        link: {
          status: "REVOKED",
          expiresAt: null,
          maxUses: null,
          usedCount: 0,
        },
        membership: { status: "ACTIVE" },
      })
    ).toBe("ALREADY_MEMBER");
  });

  it("a dead link outranks capacity and the block", () => {
    for (const link of [
      { status: "REVOKED", expiresAt: null, maxUses: null, usedCount: 0 },
      {
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 1000),
        maxUses: null,
        usedCount: 0,
      },
      { status: "ACTIVE", expiresAt: null, maxUses: 5, usedCount: 5 },
    ]) {
      expect(
        resolveGroupInviteState({
          ...base,
          link,
          room: { memberCount: 256, memberLimit: 256 },
          membership: { status: "BANNED" },
        })
      ).toBe("LINK_EXPIRED");
    }
  });

  it("capacity outranks the block, and both outrank CAN_JOIN", () => {
    expect(
      resolveGroupInviteState({
        ...base,
        room: { memberCount: 256, memberLimit: 256 },
        membership: { status: "KICKED" },
      })
    ).toBe("GROUP_FULL");
    expect(
      resolveGroupInviteState({ ...base, membership: { status: "KICKED" } })
    ).toBe("JOIN_BLOCKED");
    expect(resolveGroupInviteState(base)).toBe("CAN_JOIN");
  });

  it("a voluntary leaver is NOT blocked — only KICKED/BANNED are", () => {
    expect(
      resolveGroupInviteState({ ...base, membership: { status: "LEFT" } })
    ).toBe("CAN_JOIN");
  });

  it("a room's own memberLimit can only LOWER the cap, never raise it", () => {
    // Legacy row from when the schema allowed 5000.
    expect(
      resolveGroupInviteState({
        ...base,
        room: { memberCount: MAX_GROUP_MEMBERS, memberLimit: 5000 },
      })
    ).toBe("GROUP_FULL");
    // A deliberately smaller group is still honoured.
    expect(
      resolveGroupInviteState({
        ...base,
        room: { memberCount: 10, memberLimit: 10 },
      })
    ).toBe("GROUP_FULL");
  });
});

// ---------------------------------------------------------------------------
// A. Capacity
// ---------------------------------------------------------------------------
describe("A. group capacity (256)", () => {
  it("A1: at 255 the preview says CAN_JOIN, and the join lands", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(255));

    expect((await preview()).body.data.state).toBe("CAN_JOIN");
    expect((await join()).status).toBe(200);
    expect(mocks.groupRoomRepo.reserveMemberSlot).toHaveBeenCalledWith(
      ROOM,
      MAX_GROUP_MEMBERS
    );
  });

  it("A2/A3: at 256 both surfaces report GROUP_FULL, authed or not", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(256));

    expect((await preview()).body.data.state).toBe("GROUP_FULL");
    expect((await preview(false)).body.data.state).toBe("GROUP_FULL");
  });

  it("A4/A5/A6: a freed slot flips the state straight back to CAN_JOIN", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(256));
    expect((await preview()).body.data.state).toBe("GROUP_FULL");

    // Someone left / was removed / was banned — the roster shrinks by one.
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(255));
    expect((await preview()).body.data.state).toBe("CAN_JOIN");
  });

  it("A7/E4: with one slot left, exactly one of two concurrent joins wins", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(255));
    // The real primitive is a single conditional document update, so only the
    // first caller can observe `memberCount < limit`.
    let granted = 0;
    mocks.groupRoomRepo.reserveMemberSlot.mockImplementation(async () => {
      granted += 1;
      return granted === 1;
    });

    const [a, b] = await Promise.all([join(), join()]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 400]);
    expect(mocks.groupMemberRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("A8/E1: an ADMIN's manual add is refused past the cap too", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(256));
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "ADMIN",
      status: "ACTIVE",
    });

    const res = await request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: OTHER });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("A11/E5: the count is read from the room, never from the request", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(256));

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      // A client claiming there is room changes nothing.
      .send({ token: TOKEN, memberCount: 1, memberLimit: 9999 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHAT_GROUP_MEMBER_LIMIT_REACHED");
  });

  it("a slot claimed for a write that then fails is handed back", async () => {
    mocks.groupMemberRepo.upsert.mockRejectedValue(new Error("write failed"));

    await join();

    expect(mocks.groupRoomRepo.incMemberCount).toHaveBeenCalledWith(ROOM, -1);
  });
});

// ---------------------------------------------------------------------------
// B. Rejoin block
// ---------------------------------------------------------------------------
describe("B. rejoin block (removed / banned)", () => {
  it.each([
    ["B1 removed by the admin", "KICKED"],
    ["B2 banned", "BANNED"],
  ])("%s: the link is refused with its own code", async (_label, status) => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({ status });

    expect((await preview()).body.data.state).toBe("JOIN_BLOCKED");
    const res = await join();
    expect(res.status).toBe(403);
    // B8: distinct from GROUP_FULL and from the dead-link code.
    expect(res.body.code).toBe("CHAT_JOIN_BLOCKED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("B3: the block holds with free capacity and a perfectly valid link", async () => {
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(1));
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "KICKED",
    });

    expect((await join()).status).toBe(403);
  });

  it("B4: a freshly minted token is no bypass — the block is on the member row", async () => {
    const brandNew = { ...liveLink, token: "tok-brand-new-0", usedCount: 0 };
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(brandNew);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "BANNED",
    });

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: "tok-brand-new-0" });

    expect(res.status).toBe(403);
  });

  it("B5: once the admin re-adds them, the same link reads ALREADY_MEMBER", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await preview();
    expect(res.body.data.state).toBe("ALREADY_MEMBER");
    expect(res.body.data.isJoined).toBe(true);
  });

  it("B6: a voluntary leaver rejoins on the same link", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
    });

    expect((await preview()).body.data.state).toBe("CAN_JOIN");
    expect((await join()).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C. Link revocation
// ---------------------------------------------------------------------------
describe("C. link revocation", () => {
  const revoked = { ...liveLink, status: "REVOKED", revokedAt: new Date() };

  it("C2/C3: an old token reports the dead-link state, not a generic 404", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);

    const res = await preview();
    expect(res.status).toBe(400);
    // This exact code is what the client turns into the "Invitation link
    // expired" toast / button text.
    expect(res.body.code).toBe("CHAT_INVITE_LINK_EXPIRED");
  });

  it("C4/C5/E3: joining with a revoked token is refused, expiry and uses untouched", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);

    const res = await join();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CHAT_INVITE_LINK_EXPIRED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("C6: revoke kills a brand-new link and mints a replacement immediately", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
      status: "ACTIVE",
    });
    mocks.groupInviteLinkRepo.revoke.mockResolvedValue(revoked);
    mocks.groupInviteLinkRepo.create.mockImplementation(
      async (data: { token: string }) => data
    );

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data.link.token).not.toBe(TOKEN);
    expect(mocks.groupInviteLinkRepo.revokeAllForRoom).toHaveBeenCalled();
  });

  it("C10: time-expired and uses-exhausted read exactly like revoked", async () => {
    for (const dead of [
      { ...liveLink, expiresAt: new Date(Date.now() - 1000) },
      { ...liveLink, maxUses: 3, usedCount: 3 },
    ]) {
      mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(dead);
      const res = await preview();
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("CHAT_INVITE_LINK_EXPIRED");
    }
  });

  it("E6: a MEMBER cannot revoke", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
      status: "ACTIVE",
    });

    const res = await request(app)
      .post("/api/chat/invite-links/revoke")
      .set(bearer(makeAccessToken()))
      .send({ token: TOKEN });

    expect(res.status).toBe(400);
    expect(mocks.groupInviteLinkRepo.revoke).not.toHaveBeenCalled();
  });

  it("a member keeps View Group on a dead link — their access never needed it", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("ALREADY_MEMBER");
  });
});

// ---------------------------------------------------------------------------
// D. Cross-session sync — the SERVER half.
//
// Every one of this user's other sessions listens on their own `user:<id>`
// channel (that is what `useLiveGroupMembership` subscribes to), so the whole
// cross-session flip reduces to one question: does a membership change publish
// there? These pin that. The client half is the hook folding the event over the
// server state — see `applyMembershipDelta` in the web app.
// ---------------------------------------------------------------------------
describe("D. cross-session membership events", () => {
  /** Every `redis.publish` call as `{ channel, event, data }`. */
  const publishes = () =>
    mocks.redis.publish.mock.calls.map(
      ([channel, raw]: [string, string]) => ({
        channel,
        ...(JSON.parse(raw) as { event: string; data: Record<string, unknown> }),
      })
    );

  it("D1: joining by link publishes group:added on the JOINER's own channel", async () => {
    await join();

    const added = publishes().filter((p) => p.event === "group:added");
    expect(added.map((p) => p.channel)).toEqual([`user:${TEST_USER_ID}`]);
    // D5: the payload names the room, so a card for another group ignores it.
    expect(added[0]!.data.roomId).toBe(ROOM);
  });

  it("D3: a kick publishes group:removed with reason KICK on the target's channel", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
      async (_roomId: string, userId: string) =>
        userId === TEST_USER_ID
          ? { userId: TEST_USER_ID, role: "ADMIN", status: "ACTIVE" }
          : { userId: OTHER, role: "MEMBER", status: "ACTIVE" }
    );
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
      { userId: TEST_USER_ID },
    ]);
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: OTHER,
      status: "KICKED",
    });

    await request(app)
      .post("/api/chat/group-members/kick")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, userId: OTHER });

    const removed = publishes().filter((p) => p.event === "group:removed");
    expect(removed.map((p) => p.channel)).toEqual([`user:${OTHER}`]);
    // The reason is what tells the card "blocked" rather than "Join Group".
    expect(removed[0]!.data.reason).toBe("KICK");
  });

  it("D3: a voluntary leave says LEAVE — the card must offer Join Group again", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      userId: TEST_USER_ID,
      role: "MEMBER",
      status: "ACTIVE",
    });
    mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([]);
    mocks.groupMemberRepo.updateStatus.mockResolvedValue({
      userId: TEST_USER_ID,
      status: "LEFT",
    });

    await request(app)
      .post(`/api/chat/group-members/${ROOM}/leave`)
      .set(bearer(makeAccessToken()))
      .send({});

    const removed = publishes().filter((p) => p.event === "group:removed");
    expect(removed[0]!.data.reason).toBe("LEAVE");
  });
});

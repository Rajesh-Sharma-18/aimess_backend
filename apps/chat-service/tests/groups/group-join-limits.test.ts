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
import {
  resolveGroupInviteState,
  type GroupInviteStateInput,
} from "../../src/lib/group-invite-state.js";
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
    room: { status: "ACTIVE", memberCount: 3, memberLimit: MAX_GROUP_MEMBERS },
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

  it("a dead link outranks capacity and the block, and names its OWN cause", () => {
    const cases: Array<[GroupInviteStateInput["link"], string]> = [
      [
        { status: "REVOKED", expiresAt: null, maxUses: null, usedCount: 0 },
        "LINK_REVOKED",
      ],
      // No LINK_EXPIRED case: a link does not lapse on a clock, so a row still
      // carrying an expiry stamped by an older build is read as live.
      [
        { status: "ACTIVE", expiresAt: null, maxUses: 5, usedCount: 5 },
        "LINK_USED_UP",
      ],
      [null, "LINK_NOT_FOUND"],
    ];
    for (const [link, expected] of cases) {
      expect(
        resolveGroupInviteState({
          ...base,
          link,
          room: { status: "ACTIVE", memberCount: 256, memberLimit: 256 },
          membership: { status: "BANNED" },
        })
      ).toBe(expected);
    }
  });

  // `treatLinkAsLive` is the in-chat invitation CARD: a record of a share, not a
  // live view of the link. Only the LINK verdict is suppressed.
  describe("treatLinkAsLive — the historical invitation card", () => {
    const dead = {
      status: "REVOKED",
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
    };

    it("reads a revoked link as still joinable", () => {
      expect(
        resolveGroupInviteState({
          ...base,
          link: dead,
          treatLinkAsLive: true,
        })
      ).toBe("CAN_JOIN");
    });

    it("still reports capacity, the block and a dead group", () => {
      expect(
        resolveGroupInviteState({
          ...base,
          link: dead,
          room: { status: "ACTIVE", memberCount: 256, memberLimit: 256 },
          treatLinkAsLive: true,
        })
      ).toBe("GROUP_FULL");
      expect(
        resolveGroupInviteState({
          ...base,
          link: dead,
          membership: { status: "BANNED" },
          treatLinkAsLive: true,
        })
      ).toBe("JOIN_BLOCKED");
      expect(
        resolveGroupInviteState({
          ...base,
          link: dead,
          room: { status: "DISBANDED", memberCount: 3 },
          treatLinkAsLive: true,
        })
      ).toBe("GROUP_DISBANDED");
    });

    it("still reports membership, so a joiner gets View Group", () => {
      expect(
        resolveGroupInviteState({
          ...base,
          link: dead,
          membership: { status: "ACTIVE" },
          treatLinkAsLive: true,
        })
      ).toBe("ALREADY_MEMBER");
    });

    it("a card with no token has nothing to offer, historical or not", () => {
      expect(
        resolveGroupInviteState({
          ...base,
          link: null,
          hasToken: false,
          treatLinkAsLive: true,
        })
      ).toBe("LINK_NOT_FOUND");
    });
  });

  it("the GROUP outranks the link — a dead group is not a link problem", () => {
    const dead = {
      status: "REVOKED",
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
    };
    expect(resolveGroupInviteState({ ...base, link: dead, room: null })).toBe(
      "GROUP_NOT_FOUND"
    );
    expect(
      resolveGroupInviteState({
        ...base,
        link: dead,
        room: { status: "DISBANDED", memberCount: 3 },
      })
    ).toBe("GROUP_DISBANDED");
    expect(
      resolveGroupInviteState({
        ...base,
        link: dead,
        room: { status: "CLOSED", memberCount: 3 },
      })
    ).toBe("GROUP_CLOSED");
    expect(
      resolveGroupInviteState({ ...base, link: dead, activeAdminCount: 0 })
    ).toBe("GROUP_NO_ADMIN");
  });

  it("a member still opens their group when the link is dead or the group is closed", () => {
    for (const room of [
      { status: "ACTIVE", memberCount: 256, memberLimit: 256 },
      { status: "CLOSED", memberCount: 3 },
    ]) {
      expect(
        resolveGroupInviteState({
          ...base,
          room,
          link: null,
          hasToken: false,
          membership: { status: "ACTIVE" },
        })
      ).toBe("ALREADY_MEMBER");
    }
    // ...but a DISBANDED group is gone for its members too.
    expect(
      resolveGroupInviteState({
        ...base,
        room: { status: "DISBANDED", memberCount: 3 },
        membership: { status: "ACTIVE" },
      })
    ).toBe("GROUP_DISBANDED");
  });

  it("capacity outranks the block, and both outrank CAN_JOIN", () => {
    expect(
      resolveGroupInviteState({
        ...base,
        room: { status: "ACTIVE", memberCount: 256, memberLimit: 256 },
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
        room: {
          status: "ACTIVE",
          memberCount: MAX_GROUP_MEMBERS,
          memberLimit: 5000,
        },
      })
    ).toBe("GROUP_FULL");
    // A deliberately smaller group is still honoured.
    expect(
      resolveGroupInviteState({
        ...base,
        room: { status: "ACTIVE", memberCount: 10, memberLimit: 10 },
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

  // THE REGRESSION THIS FILE EXISTS FOR: a revoked link used to answer the
  // preview with an ERROR, so the client had a failure and no state and could
  // only send the user to the expired-link screen. It is a 200 + state now, and
  // the group is still named, so the reason renders on the screen the user is
  // already on.
  it("C2/C3: a revoked token is a 200 STATE, and its own state at that", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);

    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("LINK_REVOKED");
    expect(res.body.data.groupName).toBe("Devs");
  });

  it("C4/C5/E3: joining with a revoked token is refused with its OWN code", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);

    const res = await join();
    expect(res.status).toBe(400);
    // Not the generic CHAT_INVITE_LINK_EXPIRED any more.
    expect(res.body.code).toBe("CHAT_INVITE_LINK_REVOKED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("C3b: a MEMBER holding a revoked link still gets ALREADY_MEMBER", async () => {
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(revoked);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
      role: "MEMBER",
    });

    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("ALREADY_MEMBER");
    expect(res.body.data.groupId).toBe(ROOM);
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

  it("C10: every dead-link cause gets its own state and its own join code", async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [
        { ...liveLink, maxUses: 3, usedCount: 3 },
        "LINK_USED_UP",
        "CHAT_INVITE_LINK_USAGE_LIMIT",
      ],
      [revoked, "LINK_REVOKED", "CHAT_INVITE_LINK_REVOKED"],
    ];
    for (const [dead, state, code] of cases) {
      mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(dead);
      const shown = await preview();
      expect(shown.status).toBe(200);
      expect(shown.body.data.state).toBe(state);

      const attempted = await join();
      expect(attempted.status).toBe(400);
      expect(attempted.body.code).toBe(code);
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

// ---------------------------------------------------------------------------
// G. Group lifecycle and ownership — the states that used to be reported as
//    "invitation link expired" because nothing else could express them.
// ---------------------------------------------------------------------------
describe("G. group existence, lifecycle and ownership", () => {
  it("G1: no group row → GROUP_NOT_FOUND on preview, 404 on join", async () => {
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue(null);

    const shown = await preview();
    expect(shown.status).toBe(200);
    expect(shown.body.data.state).toBe("GROUP_NOT_FOUND");

    const attempted = await join();
    expect(attempted.status).toBe(404);
    expect(attempted.body.code).toBe("CHAT_GROUP_NO_LONGER_EXISTS");
  });

  it("G2: a DISBANDED group is its own state, not a dead link", async () => {
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
      ...roomAt(3),
      status: "DISBANDED",
    });

    const shown = await preview();
    expect(shown.body.data.state).toBe("GROUP_DISBANDED");

    const attempted = await join();
    expect(attempted.status).toBe(404);
    expect(attempted.body.code).toBe("CHAT_GROUP_DISBANDED");
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("G3: a CLOSED group (owner banned) is refused with its own code", async () => {
    // `findActiveByRoomId` lets CLOSED through, which is exactly why the state
    // has to read the row at ANY status — before this, a closed group previewed
    // as perfectly joinable and only failed at the write.
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
      ...roomAt(3),
      status: "CLOSED",
    });

    const shown = await preview();
    expect(shown.body.data.state).toBe("GROUP_CLOSED");

    const attempted = await join();
    expect(attempted.status).toBe(403);
    expect(attempted.body.code).toBe("CHAT_GROUP_CLOSED_ADMIN_BANNED");
  });

  it("G4: a group with no ACTIVE admin left admits nobody", async () => {
    mocks.groupMemberRepo.countActiveByRole.mockResolvedValue(0);

    const shown = await preview();
    expect(shown.body.data.state).toBe("GROUP_NO_ADMIN");
    expect(mocks.groupMemberRepo.countActiveByRole).toHaveBeenCalledWith(
      ROOM,
      "ADMIN"
    );

    const attempted = await join();
    expect(attempted.status).toBe(404);
    expect(attempted.body.code).toBe("CHAT_GROUP_NO_ACTIVE_ADMIN");
  });

  it("G5: the admin check is skipped for an already-disqualified group", async () => {
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
      ...roomAt(3),
      status: "DISBANDED",
    });

    await preview();

    expect(mocks.groupMemberRepo.countActiveByRole).not.toHaveBeenCalled();
  });

  it("G6: the preview NEVER errors on a state — every outcome is a 200", async () => {
    const outcomes: Array<[() => void, string]> = [
      [
        () => mocks.groupRoomRepo.findByRoomId.mockResolvedValue(null),
        "GROUP_NOT_FOUND",
      ],
      [
        () =>
          mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
            ...roomAt(3),
            status: "DISBANDED",
          }),
        "GROUP_DISBANDED",
      ],
      [
        () => mocks.groupMemberRepo.countActiveByRole.mockResolvedValue(0),
        "GROUP_NO_ADMIN",
      ],
      [
        () =>
          mocks.groupInviteLinkRepo.findByToken.mockResolvedValue({
            ...liveLink,
            status: "REVOKED",
          }),
        "LINK_REVOKED",
      ],
      [
        () => mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(null),
        "LINK_NOT_FOUND",
      ],
      [
        () => mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(256)),
        "GROUP_FULL",
      ],
      [
        () =>
          mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
            status: "BANNED",
          }),
        "JOIN_BLOCKED",
      ],
    ];

    for (const [arrange, expected] of outcomes) {
      ({ app, mocks } = buildApp());
      mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
      mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(liveLink);
      mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue(roomAt(3));
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
      arrange();

      const res = await preview();
      expect([res.status, res.body.data?.state]).toEqual([200, expected]);
    }
  });
});

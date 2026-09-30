/**
 * Community invitation / join behaviour across PRIVATE ⇄ PUBLIC transitions.
 *
 * The rule under test: invitation VALIDITY belongs to the link; join BEHAVIOUR
 * belongs to the community's CURRENT privacy. A link never carries the type it
 * was minted under, a privacy change never invalidates a link (only Reset Link
 * does), PRIVATE → PUBLIC settles every live join request, and nothing — a
 * stale client, an old link, a race — lets anyone bypass a ban or a PRIVATE
 * community's approval queue.
 *
 * The repository is replaced by a small in-memory store that keeps the real
 * invariants the Prisma layer enforces (unique (communityId, userId) on members
 * and requests, a membership write resolving the user's PENDING request in the
 * same unit, the guarded reactivation, the conditional request transitions), so
 * the SERVICE logic — including interleaved concurrent calls — runs for real.
 */

import { Prisma } from "../../src/generated/prisma/index.js";
import {
  communityService,
  selectCommunityUpdateSuccessKey,
} from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { MemberAlreadyActiveError } from "../../src/lib/member-already-active-error.js";
import { publishChatUserEvent } from "@aimess/redis";
import {
  publishCommunityJoinRequestApprovedSafe,
  publishCommunityJoinRequestedSafe,
  publishCommunityMemberAddedSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";
import { fetchAcceptedFriendIds } from "../../src/lib/user-client.js";

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK_A = "LinkAcode";
const LINK_B = "LinkBcode";

type Row = Record<string, unknown> & { userId: string; status: string };

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
let community: Record<string, unknown> | null;
let members: Map<string, Row>;
let requests: Map<string, Row & { id: string }>;
let links: Map<string, Record<string, unknown>>;
let seq = 0;

/** Yield to the event loop so concurrently started calls really interleave. */
const tick = () => new Promise((r) => setImmediate(r));

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

function resolvePending(userId: string, by: string) {
  const r = requests.get(userId);
  if (r && r.status === "PENDING") {
    r.status = "AUTO_RESOLVED";
    r.decidedBy = by;
    r.decidedAt = new Date();
  }
}

const fake = {
  findById: async () => {
    await tick();
    return community && !community.deletedAt ? { ...community } : null;
  },
  updateCommunity: async (_id: string, data: Record<string, unknown>) => {
    await tick();
    Object.assign(community!, data, { updatedAt: new Date() });
    return { ...community! };
  },
  findMembership: async (_c: string, userId: string) => {
    await tick();
    const m = members.get(userId);
    return m ? { ...m } : null;
  },
  findMemberByUserId: async (_c: string, userId: string) => {
    await tick();
    const m = members.get(userId);
    return m ? { ...m } : null;
  },
  findMembersByUserIds: async (_c: string, ids: string[]) =>
    ids.filter((id) => members.has(id)).map((id) => ({ ...members.get(id)! })),
  findActiveMemberIdsByRoles: async (_c: string, roles: string[]) =>
    [...members.values()]
      .filter((m) => m.status === "ACTIVE" && roles.includes(m.role as string))
      .map((m) => m.userId),
  findActiveMemberIds: async () =>
    [...members.values()]
      .filter((m) => m.status === "ACTIVE")
      .map((m) => m.userId),
  countActiveMembers: async () =>
    [...members.values()].filter((m) => m.status === "ACTIVE").length,
  setMemberCount: async (_c: string, n: number) => {
    community!.memberCount = n;
  },
  updateLastActivity: async () => undefined,
  createAuditLog: async () => undefined,
  findInviteByCommunityAndInvitee: async () => null,
  findCommunityByInvitationCode: async () => null,
  findInviteLinkByCode: async (code: string) => {
    await tick();
    const l = links.get(code);
    return l ? { ...l } : null;
  },
  findInviteLinkById: async (id: string) => {
    const l = [...links.values()].find((x) => x.id === id);
    return l ? { ...l } : null;
  },
  updateInviteLink: async (id: string, data: Record<string, unknown>) => {
    const l = [...links.values()].find((x) => x.id === id)!;
    Object.assign(l, data);
    return { ...l };
  },
  incrementInviteLinkUsageIfUnder: async (id: string) => {
    const l = [...links.values()].find((x) => x.id === id)!;
    if (l.maxUses !== null && (l.usedCount as number) >= (l.maxUses as number))
      return { count: 0 };
    l.usedCount = (l.usedCount as number) + 1;
    return { count: 1 };
  },
  findJoinRequestByCommunityAndUser: async (_c: string, userId: string) => {
    await tick();
    const r = requests.get(userId);
    return r ? { ...r } : null;
  },
  findJoinRequestById: async (id: string) => {
    await tick();
    const r = [...requests.values()].find((x) => x.id === id);
    return r ? { ...r } : null;
  },
  createJoinRequest: async (data: {
    userId: string;
    message: string | null;
    inviteCode?: string | null;
  }) => {
    await tick();
    if (requests.has(data.userId)) throw p2002();
    const row = {
      id: `req-${++seq}`,
      communityId: CID,
      userId: data.userId,
      status: "PENDING",
      message: data.message,
      inviteCode: data.inviteCode ?? null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    requests.set(data.userId, row);
    return { ...row };
  },
  recyclePendingJoinRequest: async (
    id: string,
    message: string | null,
    inviteCode?: string | null
  ) => {
    const r = [...requests.values()].find((x) => x.id === id)!;
    Object.assign(r, {
      status: "PENDING",
      message,
      inviteCode: inviteCode ?? null,
      decidedBy: null,
      decidedAt: null,
    });
    return { ...r };
  },
  updateJoinRequest: async (id: string, data: Record<string, unknown>) => {
    const r = [...requests.values()].find((x) => x.id === id)!;
    Object.assign(r, data);
    return { ...r };
  },
  settlePendingJoinRequest: async (
    id: string,
    data: Record<string, unknown>
  ) => {
    await tick();
    const r = [...requests.values()].find((x) => x.id === id);
    if (!r || r.status !== "PENDING") return null;
    Object.assign(r, data);
    return { ...r };
  },
  bulkUpdateJoinRequestStatus: async () => ({ count: 0 }),
  findPendingJoinRequestsForUsers: async (_c: string, ids: string[]) =>
    ids
      .map((id) => requests.get(id))
      .filter((r) => r?.status === "PENDING")
      .map((r) => ({ id: r!.id, userId: r!.userId })),
  findPendingJoinRequestsForCommunity: async () =>
    [...requests.values()]
      .filter((r) => r.status === "PENDING")
      .map((r) => ({ id: r.id, userId: r.userId, inviteCode: r.inviteCode })),
  createMember: async (data: Row, resolvedBy?: string) => {
    await tick();
    if (members.has(data.userId)) throw p2002();
    const row = { ...data, joinedAt: new Date() };
    members.set(data.userId, row);
    resolvePending(data.userId, resolvedBy ?? data.userId);
    return { ...row };
  },
  reactivateMemberWithSnapshot: async (
    _c: string,
    userId: string,
    snapshot: Record<string, unknown>,
    resolvedBy?: string,
    code?: string | null
  ) => {
    await tick();
    const m = members.get(userId);
    if (!m || m.status === "ACTIVE") throw new MemberAlreadyActiveError();
    Object.assign(m, snapshot, {
      status: "ACTIVE",
      role: "MEMBER",
      joinedAt: new Date(),
      removedAt: undefined,
      bannedAt: undefined,
      joinedViaInviteCode: code ?? undefined,
    });
    resolvePending(userId, resolvedBy ?? userId);
    return { ...m };
  },
  // Emulates the interactive transaction: atomic (no await between the claim
  // and the member write), re-reading current state inside it.
  settleJoinRequestToMember: async (args: {
    requestId: string;
    userId: string;
    snapshot: Record<string, unknown>;
    resolvedBy: string;
    inviteCode: string | null;
  }) => {
    await tick();
    const r = [...requests.values()].find((x) => x.id === args.requestId);
    if (!r || r.status !== "PENDING") return { outcome: "NOT_PENDING" };
    const m = members.get(args.userId);
    if (m?.status === "BANNED") return { outcome: "BANNED" };
    r.status = "AUTO_RESOLVED";
    r.decidedBy = args.resolvedBy;
    r.decidedAt = new Date();
    if (m?.status === "ACTIVE") return { outcome: "ALREADY_MEMBER" };
    const row = {
      ...(m ?? {}),
      communityId: CID,
      userId: args.userId,
      role: "MEMBER",
      status: "ACTIVE",
      ...args.snapshot,
      joinedAt: new Date(),
      joinedViaInviteCode: args.inviteCode,
    };
    members.set(args.userId, row);
    return { outcome: "ACTIVATED", member: { ...row }, clearedMutes: 0 };
  },
};

const repo = communityRepository as unknown as Record<string, unknown>;
const addedPub = publishCommunityMemberAddedSafe as jest.Mock;
const approvedPub = publishCommunityJoinRequestApprovedSafe as jest.Mock;
const requestedPub = publishCommunityJoinRequestedSafe as jest.Mock;
const sysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const userEvt = publishChatUserEvent as jest.Mock;

function seedMember(userId: string, over: Partial<Row> = {}) {
  members.set(userId, {
    communityId: CID,
    userId,
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt: new Date("2026-01-01"),
    snapshotUsername: userId,
    snapshotDisplayName: userId,
    snapshotAvatarKey: null,
    ...over,
  });
}

function seedLink(code: string, over: Record<string, unknown> = {}) {
  links.set(code, {
    id: `link-${code}`,
    code,
    communityId: CID,
    createdBy: MOD,
    maxUses: null,
    usedCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...over,
  });
}

const setType = (type: "PUBLIC" | "PRIVATE") =>
  communityService.update(CID, ADMIN, { type } as never);

const memberStatus = (u: string) => members.get(u)?.status ?? null;
const requestStatus = (u: string) => requests.get(u)?.status ?? null;
const joinLinesFor = (u: string) =>
  sysMsg.mock.calls
    .map(([p]) => p)
    .filter(
      (p) =>
        p.visibleToUserId === u &&
        ["COMMUNITY_JOINED", "MEMBER_ADDED"].includes(p.systemMessageType)
    );
const memberAddedFor = (u: string) =>
  addedPub.mock.calls.map(([p]) => p).filter((p) => p.targetUserId === u);
const communityAddedFor = (u: string) =>
  userEvt.mock.calls.filter(
    ([, id, ev]) => id === u && ev === "community:added"
  );

beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
  community = {
    id: CID,
    name: "Transit Club",
    handle: "transit_club",
    description: null,
    type: "PRIVATE",
    categoryId: "d".repeat(24),
    category: { id: "d".repeat(24), name: "General" },
    avatarUrl: null,
    coverUrl: null,
    adminId: ADMIN,
    creatorId: ADMIN,
    memberCount: 3,
    moderationStatus: "ACTIVE",
    status: "ACTIVE",
    deletedAt: null,
    invitationCode: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
  members = new Map();
  requests = new Map();
  links = new Map();
  seedMember(ADMIN, { role: "ADMIN" });
  seedMember(MOD, { role: "MODERATOR" });
  seedMember(MEMBER);
  seedLink(LINK_A);
  Object.assign(repo, fake);
  (fetchAcceptedFriendIds as jest.Mock).mockImplementation(
    async (_c: string, ids: string[]) => new Set(ids)
  );
});

// ---------------------------------------------------------------------------
// 1-4: the link never carries the type it was minted under
// ---------------------------------------------------------------------------
describe("current privacy decides — not the privacy the link was minted under", () => {
  it("1. PRIVATE link + current PRIVATE → a PENDING request, no membership", async () => {
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.request?.status).toBe("PENDING");
    expect(res.member).toBeUndefined();
    expect(memberStatus(A)).toBeNull();
  });

  it("2. PRIVATE-minted link, community now PUBLIC → direct join, no request", async () => {
    await setType("PUBLIC");
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member?.userId).toBe(A);
    expect(res.request).toBeUndefined();
    expect(memberStatus(A)).toBe("ACTIVE");
    expect(requests.has(A)).toBe(false);
    expect(members.get(A)!.joinedViaInviteCode).toBe(LINK_A);
  });

  it("3. PUBLIC link + current PUBLIC → direct join (was a PENDING request before)", async () => {
    community!.type = "PUBLIC";
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member?.userId).toBe(A);
    expect(requests.has(A)).toBe(false);
    expect(memberAddedFor(A)).toHaveLength(1);
    expect(joinLinesFor(A)).toHaveLength(1);
  });

  it("4. PUBLIC-minted link, community now PRIVATE → request, never a direct join", async () => {
    community!.type = "PUBLIC";
    await setType("PRIVATE");
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member).toBeUndefined();
    expect(res.request?.status).toBe("PENDING");
    expect(memberStatus(A)).toBeNull();
    expect(requestedPub).toHaveBeenCalledTimes(1);
  });

  // `autoApprove` was the mint-time privacy wearing another name: free to set
  // while the community was open, and it used to outlive the switch that closed
  // it. The field is retired and nothing writes it any more — but documents an
  // older build wrote still carry it, so these seed it deliberately: a legacy
  // row must grant nothing the community does not currently grant.
  it("a legacy auto-approve link a plain MEMBER minted while PUBLIC grants nothing once PRIVATE", async () => {
    community!.type = "PUBLIC";
    seedLink(LINK_B, { autoApprove: true, createdBy: MEMBER });
    await setType("PRIVATE");
    const res = await communityService.redeemInviteLink(LINK_B, A);
    expect(res.request?.status).toBe("PENDING");
    expect(memberStatus(A)).toBeNull();
  });

  it("a legacy auto-approve link a MODERATOR minted files a request like any other once PRIVATE", async () => {
    seedLink(LINK_B, { autoApprove: true, createdBy: MOD });
    const res = await communityService.redeemInviteLink(LINK_B, A);
    expect(res.member).toBeUndefined();
    expect(res.request?.status).toBe("PENDING");
    expect(memberStatus(A)).toBeNull();
  });

  it("the same legacy link admits directly while PUBLIC", async () => {
    community!.type = "PUBLIC";
    seedLink(LINK_B, { autoApprove: true, createdBy: MOD });
    const res = await communityService.redeemInviteLink(LINK_B, B);
    expect(res.member?.userId).toBe(B);
    expect(memberStatus(B)).toBe("ACTIVE");
  });

  it("the response reports the retired flag false even for a legacy true row", async () => {
    community!.type = "PUBLIC";
    seedLink(LINK_B, { autoApprove: true, createdBy: MOD });
    const res = await communityService.redeemInviteLink(LINK_B, B);
    expect(res.link.autoApprove).toBe(false);
  });

  it("the lookup preview reports the CURRENT type after every flip", async () => {
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).communityType
    ).toBe("PRIVATE");
    await setType("PUBLIC");
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).communityType
    ).toBe("PUBLIC");
  });
});

// ---------------------------------------------------------------------------
// 5-7, 38: PRIVATE → PUBLIC auto-resolves live requests
// ---------------------------------------------------------------------------
describe("PRIVATE → PUBLIC settles pending requests", () => {
  it("5/6/7. PENDING → AUTO_RESOLVED, ACTIVE member, and the preview flips to View Community", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).joinRequestStatus
    ).toBe("PENDING");

    await setType("PUBLIC");

    expect(requestStatus(A)).toBe("AUTO_RESOLVED");
    expect(requests.get(A)!.decidedBy).toBe(ADMIN);
    expect(memberStatus(A)).toBe("ACTIVE");
    // The invitation the request came from is carried to the membership, so
    // the DM card for THAT code flips to View Community.
    expect(members.get(A)!.joinedViaInviteCode).toBe(LINK_A);

    const preview = await communityService.lookupInviteLink(LINK_A, A);
    expect(preview.isJoined).toBe(true);
    expect(preview.joinRequestStatus).toBeNull();
  });

  it("announces exactly once, truthfully, and only to the joiner", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    jest.clearAllMocks();

    await setType("PUBLIC");

    const added = memberAddedFor(A);
    expect(added).toHaveLength(1);
    expect(added[0].via).toBe("join_request_auto_accept"); // never "approved"
    expect(approvedPub).not.toHaveBeenCalled();
    // One personal line, visible only to the joiner — nothing room-wide.
    const lines = joinLinesFor(A);
    expect(lines).toHaveLength(1);
    expect(lines[0].systemMessageType).toBe("COMMUNITY_JOINED");
    // All of their devices get community:added (Cancel Request → View Community).
    expect(communityAddedFor(A)).toHaveLength(1);
    expect(communityAddedFor(A)[0][3]).toMatchObject({
      communityId: CID,
      via: "join_request_auto_accept",
      joinedViaInviteCode: LINK_A,
    });
    // 38/39: every admin queue drops the row.
    expect(
      userEvt.mock.calls.filter(
        ([, , ev, p]) =>
          ev === "community:join_request:updated" &&
          p.status === "AUTO_RESOLVED"
      ).length
    ).toBeGreaterThan(0);
  });

  it("resolving many requests posts no room-wide line and one join line per user", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    await communityService.redeemInviteLink(LINK_A, B);
    jest.clearAllMocks();
    await setType("PUBLIC");
    expect(joinLinesFor(A)).toHaveLength(1);
    expect(joinLinesFor(B)).toHaveLength(1);
    // The only unaddressed line is the admin's own privacy-change line —
    // auto-resolved requests never post an "approved" line (AUTO_RESOLVED is
    // not an admin decision); each user only gets their personal join line.
    const roomWide = sysMsg.mock.calls
      .map(([p]) => p)
      .filter((p) => !p.visibleToUserId);
    expect(roomWide.map((p) => p.systemMessageType)).toEqual([
      "COMMUNITY_PRIVACY_CHANGED",
    ]);
    expect(roomWide[0].metadata).toMatchObject({
      oldVisibility: "PRIVATE",
      newVisibility: "PUBLIC",
    });
    const personalTypes = sysMsg.mock.calls
      .map(([p]) => p)
      .filter((p) => p.visibleToUserId)
      .map((p) => p.systemMessageType);
    expect(personalTypes).not.toContain("JOIN_REQUEST_APPROVED");
  });

  it("14. a BANNED user's pending request is never turned into a membership", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    members.set(A, {
      communityId: CID,
      userId: A,
      role: "MEMBER",
      status: "BANNED",
    });

    await setType("PUBLIC");

    expect(memberStatus(A)).toBe("BANNED");
    expect(requestStatus(A)).toBe("PENDING"); // untouched: nobody decided it
    expect(memberAddedFor(A)).toHaveLength(0);
  });

  it("a request whose resolution fails stays PENDING but gates nothing: the user joins directly", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    (repo.settleJoinRequestToMember as unknown) = async () => {
      throw new Error("write conflict");
    };
    await setType("PUBLIC"); // the privacy change itself still succeeds
    expect(community!.type).toBe("PUBLIC");
    expect(requestStatus(A)).toBe("PENDING");

    // Every surface reports no live request on a PUBLIC community…
    const preview = await communityService.lookupInviteLink(LINK_A, A);
    expect(preview.joinRequestStatus).toBeNull();
    // …and the join resolves the leftover row in the same unit.
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member?.userId).toBe(A);
    expect(requestStatus(A)).toBe("AUTO_RESOLVED");
  });
});

// ---------------------------------------------------------------------------
// 8-11: existing members
// ---------------------------------------------------------------------------
describe("existing members", () => {
  it("8. an ACTIVE member survives PUBLIC → PRIVATE untouched", async () => {
    community!.type = "PUBLIC";
    await communityService.redeemInviteLink(LINK_A, A);
    jest.clearAllMocks();
    await setType("PRIVATE");
    expect(memberStatus(A)).toBe("ACTIVE");
    expect(requests.has(A)).toBe(false);
    expect(memberAddedFor(A)).toHaveLength(0);
  });

  it("9. an ACTIVE member survives PRIVATE → PUBLIC with no second join", async () => {
    seedMember(A);
    await setType("PUBLIC");
    expect(memberStatus(A)).toBe("ACTIVE");
    expect(memberAddedFor(A)).toHaveLength(0);
    expect(joinLinesFor(A)).toHaveLength(0);
  });

  it.each(["PUBLIC", "PRIVATE"] as const)(
    "10/11. a member opening an invite on a %s community → View Community, nothing created",
    async (type) => {
      community!.type = type;
      seedMember(A);
      const preview = await communityService.lookupInviteLink(LINK_A, A);
      expect(preview.isJoined).toBe(true);
      const res = await communityService.redeemInviteLink(LINK_A, A);
      expect(res.member?.userId).toBe(A);
      expect(requests.has(A)).toBe(false);
      expect(links.get(LINK_A)!.usedCount).toBe(0);
      expect(memberAddedFor(A)).toHaveLength(0);
      expect(joinLinesFor(A)).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// 12-16: ban / left / removed
// ---------------------------------------------------------------------------
describe("ban and rejoin rules", () => {
  it.each([
    ["PRIVATE", null],
    ["PUBLIC", null],
    ["PRIVATE", "PUBLIC"],
    ["PUBLIC", "PRIVATE"],
  ] as const)(
    "12/13. banned user, %s community (→ %s): invite neither previews nor joins nor requests",
    async (from, to) => {
      community!.type = from;
      members.set(A, {
        communityId: CID,
        userId: A,
        role: "MEMBER",
        status: "BANNED",
      });
      if (to) await setType(to);
      await expect(
        communityService.lookupInviteLink(LINK_A, A)
      ).rejects.toThrow("COMMUNITY_JOIN_BANNED");
      await expect(
        communityService.redeemInviteLink(LINK_A, A)
      ).rejects.toThrow("COMMUNITY_JOIN_BANNED");
      expect(memberStatus(A)).toBe("BANNED");
      expect(requests.has(A)).toBe(false);
    }
  );

  it.each([
    ["LEFT", {}],
    ["REMOVED", { removedAt: new Date(), removedBy: MOD }],
  ] as const)(
    "15/16. a %s user rejoins directly when PUBLIC and must request when PRIVATE",
    async (_label, extra) => {
      members.set(A, {
        communityId: CID,
        userId: A,
        role: "MEMBER",
        status: "LEFT",
        ...extra,
      });
      members.set(B, {
        communityId: CID,
        userId: B,
        role: "MEMBER",
        status: "LEFT",
        ...extra,
      });

      const req = await communityService.redeemInviteLink(LINK_A, A);
      expect(req.request?.status).toBe("PENDING");
      expect(memberStatus(A)).toBe("LEFT");

      await setType("PUBLIC"); // A's request resolves by reactivating the row
      expect(memberStatus(A)).toBe("ACTIVE");
      expect(requestStatus(A)).toBe("AUTO_RESOLVED");

      const direct = await communityService.redeemInviteLink(LINK_A, B);
      expect(direct.member?.userId).toBe(B);
      expect(memberStatus(B)).toBe("ACTIVE");
    }
  );
});

// ---------------------------------------------------------------------------
// 17-19, 31, 33-35: link lifecycle
// ---------------------------------------------------------------------------
describe("invite link lifecycle", () => {
  it("18. privacy changes never touch the link; 17. Reset invalidates it; 19. the new link follows current privacy", async () => {
    await setType("PUBLIC");
    await setType("PRIVATE");
    expect(links.get(LINK_A)!.revokedAt).toBeNull();
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).communityType
    ).toBe("PRIVATE");

    // Reset Link = revoke the current link; the next share mints a new code.
    await communityService.revokeInviteLink(CID, ADMIN, `link-${LINK_A}`);
    seedLink(LINK_B);

    await expect(communityService.redeemInviteLink(LINK_A, A)).rejects.toThrow(
      "COMMUNITY_INVITE_LINK_REVOKED_ERROR"
    );
    await expect(communityService.lookupInviteLink(LINK_A, A)).rejects.toThrow(
      "COMMUNITY_INVITE_LINK_REVOKED_ERROR"
    );
    expect(requests.has(A)).toBe(false);
    expect(memberStatus(A)).toBeNull();

    expect(
      (await communityService.redeemInviteLink(LINK_B, A)).request?.status
    ).toBe("PENDING");
    await setType("PUBLIC");
    expect(memberStatus(A)).toBe("ACTIVE");
    expect(
      (await communityService.redeemInviteLink(LINK_B, B)).member?.userId
    ).toBe(B);
  });

  it("31. PRIVATE→PUBLIC→PRIVATE→PUBLIC→PRIVATE: the link survives and each attempt follows the type of that moment", async () => {
    const users = ["u1", "u2", "u3", "u4", "u5"].map(
      (n, i) => `${n.padEnd(8, String(i))}-0000-4000-8000-000000000000`
    );
    const outcomes: string[] = [];
    const types = [
      "PRIVATE",
      "PUBLIC",
      "PRIVATE",
      "PUBLIC",
      "PRIVATE",
    ] as const;
    for (let i = 0; i < types.length; i++) {
      if (i > 0) await setType(types[i]);
      const res = await communityService.redeemInviteLink(LINK_A, users[i]);
      outcomes.push(res.member ? "JOINED" : "REQUESTED");
    }
    expect(outcomes).toEqual([
      "REQUESTED",
      "JOINED",
      "REQUESTED",
      "JOINED",
      "REQUESTED",
    ]);
    // u1 (requested while PRIVATE) and u3 were auto-resolved by the PUBLIC flips.
    expect(memberStatus(users[0])).toBe("ACTIVE");
    expect(memberStatus(users[2])).toBe("ACTIVE");
    expect(requestStatus(users[4])).toBe("PENDING");
    expect(links.get(LINK_A)!.revokedAt).toBeNull();
    expect([...requests.values()]).toHaveLength(3); // one row per requester, no dups
    for (const u of users)
      expect(memberAddedFor(u).length).toBeLessThanOrEqual(1);
  });

  it("33. a closed, suspended or deleted community admits nobody through an invite", async () => {
    for (const patch of [
      { status: "CLOSED" },
      { moderationStatus: "SUSPENDED" },
    ]) {
      Object.assign(
        community!,
        { status: "ACTIVE", moderationStatus: "ACTIVE" },
        patch
      );
      for (const type of ["PUBLIC", "PRIVATE"]) {
        community!.type = type;
        await expect(
          communityService.redeemInviteLink(LINK_A, A)
        ).rejects.toBeDefined();
      }
    }
    Object.assign(community!, {
      status: "ACTIVE",
      moderationStatus: "ACTIVE",
      deletedAt: new Date(),
    });
    await expect(communityService.redeemInviteLink(LINK_A, A)).rejects.toThrow(
      "COMMUNITY_NOT_FOUND"
    );
    expect(memberStatus(A)).toBeNull();
    expect(requests.has(A)).toBe(false);
  });

  it("34. an unknown code is rejected", async () => {
    await expect(communityService.redeemInviteLink("nope", A)).rejects.toThrow(
      "COMMUNITY_INVITE_LINK_NOT_FOUND"
    );
  });

  it("35. expiry is the link's own clock (AIM-60) — a privacy change neither extends nor ends it", async () => {
    seedLink(LINK_B, { expiresAt: new Date(Date.now() - 1000) });
    await setType("PUBLIC");
    await expect(communityService.redeemInviteLink(LINK_B, A)).rejects.toThrow(
      "COMMUNITY_INVITE_LINK_EXPIRED"
    );
    seedLink(LINK_B, { expiresAt: new Date(Date.now() + 86_400_000) });
    await setType("PRIVATE");
    expect(
      (await communityService.redeemInviteLink(LINK_B, A)).request
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 20-21: stale clients — nothing the client believes is trusted
// ---------------------------------------------------------------------------
describe("stale clients", () => {
  it("20. client saw PUBLIC, server is now PRIVATE → request, not a join", async () => {
    community!.type = "PUBLIC";
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).communityType
    ).toBe("PUBLIC");
    await setType("PRIVATE");
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member).toBeUndefined();
    expect(res.request?.status).toBe("PENDING");
    // The community-page Join button is just as authoritative.
    const join = await communityService.joinCommunity(CID, B);
    expect(join.status).toBe("REQUEST_CREATED");
    expect(memberStatus(B)).toBeNull();
  });

  it("21. client saw PRIVATE ('Request to Join'), server is now PUBLIC → joined, no pending row", async () => {
    expect(
      (await communityService.lookupInviteLink(LINK_A, A)).communityType
    ).toBe("PRIVATE");
    await setType("PUBLIC");
    const res = await communityService.redeemInviteLink(LINK_A, A);
    expect(res.member?.userId).toBe(A);
    expect(requests.has(A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 22-30: races — started concurrently, interleaving at every await
// ---------------------------------------------------------------------------
describe("races end with one consistent outcome", () => {
  async function pending(u: string) {
    await communityService.redeemInviteLink(LINK_A, u);
    jest.clearAllMocks();
    return requests.get(u)!.id;
  }

  function assertSingleJoin(u: string) {
    expect(memberStatus(u)).toBe("ACTIVE");
    expect(memberAddedFor(u)).toHaveLength(1);
    expect(joinLinesFor(u)).toHaveLength(1);
    expect(communityAddedFor(u)).toHaveLength(1);
  }

  it("22/29. approve ∥ PRIVATE→PUBLIC → one membership, one announcement", async () => {
    const rid = await pending(A);
    await Promise.allSettled([
      communityService.approveJoinRequest(CID, MOD, rid),
      setType("PUBLIC"),
    ]);
    assertSingleJoin(A);
    expect(["APPROVED", "AUTO_RESOLVED"]).toContain(requestStatus(A));
  });

  it("22b. approve ∥ PRIVATE→PUBLIC for a LEFT user (reactivation path) → one join", async () => {
    members.set(A, {
      communityId: CID,
      userId: A,
      role: "MEMBER",
      status: "LEFT",
    });
    const rid = await pending(A);
    await Promise.allSettled([
      setType("PUBLIC"),
      communityService.approveJoinRequest(CID, MOD, rid),
    ]);
    assertSingleJoin(A);
  });

  it("23/25. Admin Add Member ∥ PRIVATE→PUBLIC → one membership, request AUTO_RESOLVED", async () => {
    await pending(A);
    await Promise.allSettled([
      communityService.addMembers(CID, ADMIN, [A]),
      setType("PUBLIC"),
    ]);
    expect(memberStatus(A)).toBe("ACTIVE");
    expect(memberAddedFor(A)).toHaveLength(1);
    expect(joinLinesFor(A)).toHaveLength(1);
    expect(requestStatus(A)).toBe("AUTO_RESOLVED");
  });

  it("25. pending + Admin Add Member (no privacy change) → AUTO_RESOLVED, never APPROVED", async () => {
    await pending(A);
    await communityService.addMembers(CID, ADMIN, [A]);
    expect(requestStatus(A)).toBe("AUTO_RESOLVED");
    expect(approvedPub).not.toHaveBeenCalled();
  });

  // The check-then-write window: the redeem read a PUBLIC community, and the
  // flip to PRIVATE lands while it is still doing its slow work (ban lookup,
  // usage-slot burn, snapshot fetch). The membership must NOT be the thing that
  // wins — whoever loses, the user ends up outside the community with a request.
  it("PUBLIC→PRIVATE landing mid-redeem → a request, never a membership", async () => {
    community!.type = "PUBLIC";
    const [res] = await Promise.all([
      communityService.redeemInviteLink(LINK_A, A),
      setType("PRIVATE"),
    ]);
    // A redeem that fully beat the flip is a legitimate PUBLIC join; one that
    // did not must have filed a request. Never both, and never a membership
    // written after the community closed.
    if (res.member) {
      expect(memberStatus(A)).toBe("ACTIVE");
    } else {
      expect(res.request?.status).toBe("PENDING");
      expect(memberStatus(A)).toBeNull();
    }
  });

  it("PUBLIC→PRIVATE landing mid-Join → a request, never a membership", async () => {
    community!.type = "PUBLIC";
    const [join] = await Promise.all([
      communityService.joinCommunity(CID, A),
      setType("PRIVATE"),
    ]);
    if (join.status === "JOINED") {
      expect(memberStatus(A)).toBe("ACTIVE");
    } else {
      expect(join.status).toBe("REQUEST_CREATED");
      expect(memberStatus(A)).toBeNull();
    }
  });

  it("24. two devices redeeming a PRIVATE invite at once → one request, one moderator ping", async () => {
    await Promise.all([
      communityService.redeemInviteLink(LINK_A, A),
      communityService.redeemInviteLink(LINK_A, A),
    ]);
    expect([...requests.values()].filter((r) => r.userId === A)).toHaveLength(
      1
    );
    expect(requestedPub).toHaveBeenCalledTimes(1);
  });

  it("24b. two devices redeeming a PUBLIC invite at once → one membership, one join", async () => {
    community!.type = "PUBLIC";
    const [r1, r2] = await Promise.all([
      communityService.redeemInviteLink(LINK_A, A),
      communityService.redeemInviteLink(LINK_A, A),
    ]);
    expect(r1.member?.userId).toBe(A);
    expect(r2.member?.userId).toBe(A);
    assertSingleJoin(A);
  });

  it("24c. double-tapped public Join button → one membership", async () => {
    community!.type = "PUBLIC";
    const results = await Promise.all([
      communityService.joinCommunity(CID, A),
      communityService.joinCommunity(CID, A),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "ALREADY_MEMBER",
      "JOINED",
    ]);
    assertSingleJoin(A);
  });

  it("28. cancel ∥ PRIVATE→PUBLIC → either cancelled with no member, or a member whose request stays resolved", async () => {
    await pending(A);
    await Promise.allSettled([
      communityService.cancelMyJoinRequest(CID, A),
      setType("PUBLIC"),
    ]);
    const s = requestStatus(A);
    if (s === "CANCELLED") {
      expect(memberStatus(A)).toBeNull();
      expect(memberAddedFor(A)).toHaveLength(0);
    } else {
      expect(s).toBe("AUTO_RESOLVED");
      assertSingleJoin(A);
    }
  });

  it("28a. cancel that lands after auto-resolve loses and leaves the membership alone", async () => {
    await pending(A);
    await setType("PUBLIC");
    await expect(communityService.cancelMyJoinRequest(CID, A)).rejects.toThrow(
      "COMMUNITY_JOIN_REQUEST_NOT_PENDING"
    );
    expect(requestStatus(A)).toBe("AUTO_RESOLVED");
    expect(memberStatus(A)).toBe("ACTIVE");
  });

  it("28b. cancel that lands first wins; the flip then has nothing to resolve", async () => {
    await pending(A);
    await communityService.cancelMyJoinRequest(CID, A);
    await setType("PUBLIC");
    expect(requestStatus(A)).toBe("CANCELLED");
    expect(memberStatus(A)).toBeNull();
  });

  it("30. reject ∥ PRIVATE→PUBLIC → never a rejected member, never a resurrected request", async () => {
    const rid = await pending(A);
    await Promise.allSettled([
      communityService.rejectJoinRequest(CID, MOD, rid),
      setType("PUBLIC"),
    ]);
    const s = requestStatus(A);
    if (s === "REJECTED") expect(memberStatus(A)).toBeNull();
    else {
      expect(s).toBe("AUTO_RESOLVED");
      assertSingleJoin(A);
    }
  });

  it("30a. reject first, then PUBLIC: the terminal REJECTED is not reopened", async () => {
    const rid = await pending(A);
    await communityService.rejectJoinRequest(CID, MOD, rid);
    await setType("PUBLIC");
    expect(requestStatus(A)).toBe("REJECTED");
    expect(memberStatus(A)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regressions of the paths the change touched
// ---------------------------------------------------------------------------
describe("privacy change wording (system line + API message)", () => {
  const roomWide = () =>
    sysMsg.mock.calls.map(([p]) => p).filter((p) => !p.visibleToUserId);
  const update = async (input: Record<string, unknown>) => {
    jest.clearAllMocks();
    const res = await communityService.updateWithChanges(
      CID,
      ADMIN,
      input as never
    );
    return selectCommunityUpdateSuccessKey(
      res.changedFields,
      res.community.type
    );
  };

  it("PUBLIC → PRIVATE posts one actor-bearing privacy line", async () => {
    community!.type = "PUBLIC";
    const key = await update({ type: "PRIVATE" });
    expect(key).toBe("COMMUNITY_UPDATED_PRIVATE");
    expect(roomWide()).toHaveLength(1);
    expect(roomWide()[0]).toMatchObject({
      systemMessageType: "COMMUNITY_PRIVACY_CHANGED",
      triggeredByUserId: ADMIN,
      metadata: {
        actorUserId: ADMIN,
        oldVisibility: "PUBLIC",
        newVisibility: "PRIVATE",
      },
    });
  });

  it("PRIVATE → PUBLIC posts one actor-bearing privacy line", async () => {
    const key = await update({ type: "PUBLIC" });
    expect(key).toBe("COMMUNITY_UPDATED_PUBLIC");
    expect(roomWide().map((p) => p.systemMessageType)).toEqual([
      "COMMUNITY_PRIVACY_CHANGED",
    ]);
    expect(roomWide()[0].metadata).toMatchObject({
      oldVisibility: "PRIVATE",
      newVisibility: "PUBLIC",
    });
  });

  it("re-sending the current privacy claims nothing changed", async () => {
    const key = await update({ type: "PRIVATE" });
    expect(key).toBe("COMMUNITY_UPDATED");
    expect(roomWide()).toHaveLength(0);
  });

  it("description only → description line, never a privacy line", async () => {
    const key = await update({ type: "PRIVATE", description: "New rules" });
    expect(key).toBe("COMMUNITY_UPDATED_DESCRIPTION");
    expect(roomWide().map((p) => p.systemMessageType)).toEqual([
      "COMMUNITY_DESCRIPTION_UPDATED",
    ]);
  });

  it("privacy + description → privacy line plus the other change, each true", async () => {
    const key = await update({ type: "PUBLIC", description: "Open now" });
    expect(key).toBe("COMMUNITY_UPDATED_DETAILS");
    const lines = roomWide();
    expect(lines.map((p) => p.systemMessageType)).toEqual([
      "COMMUNITY_PRIVACY_CHANGED",
      "COMMUNITY_DESCRIPTION_UPDATED",
    ]);
    // The second line no longer claims visibility changed.
    expect(lines[1].metadata.changedFields).toEqual(["description"]);
  });
});

describe("regressions", () => {
  it("41/42. PRIVATE request → approve still APPROVES and announces once", async () => {
    await communityService.redeemInviteLink(LINK_A, A);
    const res = await communityService.approveJoinRequest(
      CID,
      MOD,
      requests.get(A)!.id
    );
    expect(res.request.status).toBe("APPROVED");
    expect(approvedPub).toHaveBeenCalledTimes(1);
    expect(memberAddedFor(A)).toHaveLength(1);
  });

  it("40. public Join on the community page still joins directly", async () => {
    community!.type = "PUBLIC";
    expect((await communityService.joinCommunity(CID, A)).status).toBe(
      "JOINED"
    );
  });

  it("a moderator can still not change privacy (ADMIN only)", async () => {
    await expect(
      communityService.update(CID, MOD, { type: "PUBLIC" } as never)
    ).rejects.toBeDefined();
    expect(community!.type).toBe("PRIVATE");
  });
});

/**
 * System Messages v2 §3 — leader succession.
 *
 * - The handover is ONE conditional transaction: the outgoing row must still be
 *   the ACTIVE leader and the successor an ACTIVE non-leader, or nothing is
 *   written — so two leaves, or a leave racing an automatic succession, can
 *   never leave zero or two leaders.
 * - Automatic succession (account deleted / suspended / banned) promotes the
 *   longest-standing ACTIVE member (joinedAt, then userId) and posts
 *   LEADER_CHANGED {auto: true}; a group with nobody to promote keeps its
 *   last-member behaviour (the system ban still closes it).
 * - The one-off migration maps MODERATOR→MEMBER, clears moderation mutes and
 *   turns BANNED into a re-addable KICKED row.
 */
import { GroupMemberRepository } from "../../src/repositories/group-member.repository.js";
import { GroupMemberService } from "../../src/services/group-member.service.js";
import { AdminGroupService } from "../../src/services/admin-group.service.js";
import {
  BANNED_WHERE,
  CLOSURE_BANNED_DATA,
  MODERATOR_DATA,
  MODERATOR_WHERE,
  MUTED_DATA,
  MUTED_WHERE,
  bannedToKicked,
} from "../../scripts/migrate-group-leader-members.js";

const ROOM = "grp_succession";

describe("GroupMemberRepository.transferLeadership", () => {
  function repoWith(fromCount: number, toCount: number) {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: fromCount })
      .mockResolvedValueOnce({ count: toCount });
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ groupMember: { updateMany } })
      ),
    };
    return { repo: new GroupMemberRepository(prisma as never), updateMany };
  }

  it("hands over only while the outgoing row is the ACTIVE leader", async () => {
    const { repo, updateMany } = repoWith(1, 1);

    await expect(repo.transferLeadership(ROOM, "lead", "next")).resolves.toBe(true);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { roomId: ROOM, userId: "lead", status: "ACTIVE", role: "ADMIN" },
      data: { role: "MEMBER" },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        roomId: ROOM,
        userId: "next",
        status: "ACTIVE",
        role: { not: "ADMIN" },
      },
      data: { role: "ADMIN" },
    });
  });

  it("leave-with-successor ends the outgoing membership in the same write", async () => {
    const { repo, updateMany } = repoWith(1, 1);
    const leftAt = new Date();

    await repo.transferLeadership(ROOM, "lead", "next", leftAt);

    expect(updateMany.mock.calls[0][0].data).toEqual({
      role: "MEMBER",
      status: "LEFT",
      leftAt,
      unreadCount: 0,
    });
  });

  it("RACE: a second handover finds no ACTIVE leader → false, successor untouched", async () => {
    const { repo, updateMany } = repoWith(0, 1);

    await expect(repo.transferLeadership(ROOM, "lead", "next")).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("RACE: successor left meanwhile → transaction aborted (rolled back), false", async () => {
    const { repo } = repoWith(1, 0);

    await expect(repo.transferLeadership(ROOM, "lead", "next")).resolves.toBe(false);
  });

  it("candidates are ACTIVE non-leaders, longest-standing first, userId tie-break", async () => {
    const findMany = jest.fn().mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    const repo = new GroupMemberRepository({ groupMember: { findMany } } as never);

    await expect(repo.findSuccessionCandidates(ROOM, "lead", 3)).resolves.toEqual([
      "a",
      "b",
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId: ROOM, status: "ACTIVE", userId: { not: "lead" } },
        orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
        take: 3,
      })
    );
  });
});

describe("GroupMemberService.autoSucceed", () => {
  function makeService(
    candidates: string[],
    transfers: boolean[],
    blocked: Record<string, string> = {}
  ) {
    const memberRepo = {
      findSuccessionCandidates: jest.fn().mockResolvedValue(candidates),
      transferLeadership: jest.fn(),
      findActiveMembers: jest.fn().mockResolvedValue([]),
      findRoomIdsByOwnerUserIds: jest.fn(),
    };
    for (const ok of transfers) memberRepo.transferLeadership.mockResolvedValueOnce(ok);
    const roomRepo = {
      findActiveByRoomId: jest.fn().mockResolvedValue(null),
      incMemberCount: jest.fn().mockResolvedValue(undefined),
    };
    const sysMsg = { post: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      publish: jest.fn().mockResolvedValue(0),
      get: jest.fn(async (key: string) => blocked[key] ?? null),
    };
    const service = new GroupMemberService(
      memberRepo as never,
      roomRepo as never,
      sysMsg as never,
      redis as never
    );
    return { service, memberRepo, sysMsg, roomRepo };
  }

  it("skips suspended and banned accounts, trying the next candidate", async () => {
    const { service, memberRepo } = makeService(["banned", "susp", "ok"], [true], {
      "aimess:user:banned:banned": "1",
      "aimess:user:suspended:susp": String(Date.now() + 60_000),
    });

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBe(true);
    expect(memberRepo.transferLeadership).toHaveBeenCalledTimes(1);
    expect(memberRepo.transferLeadership).toHaveBeenCalledWith(ROOM, "lead", "ok");
  });

  it("skips a deleted account too (same eligibility as leave-with-successor)", async () => {
    const memberRepo = {
      findSuccessionCandidates: jest.fn().mockResolvedValue(["gone", "ok"]),
      transferLeadership: jest.fn().mockResolvedValue(true),
      findActiveMembers: jest.fn().mockResolvedValue([]),
    };
    const service = new GroupMemberService(
      memberRepo as never,
      { findActiveByRoomId: jest.fn().mockResolvedValue(null) } as never,
      { post: jest.fn().mockResolvedValue(undefined) } as never,
      { publish: jest.fn().mockResolvedValue(0), get: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      {
        getUserSnapshotsMap: jest.fn().mockResolvedValue(
          new Map([["gone", { userId: "gone", memberId: "", isDeletedUser: true }]])
        ),
      } as never,
      {} as never
    );

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBe(true);
    expect(memberRepo.transferLeadership).toHaveBeenCalledTimes(1);
    expect(memberRepo.transferLeadership).toHaveBeenCalledWith(ROOM, "lead", "ok");
  });

  it("only blocked candidates → null (nobody eligible)", async () => {
    const { service, memberRepo } = makeService(["banned"], [], {
      "aimess:user:banned:banned": "1",
    });

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBeNull();
    expect(memberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("deleted leader: handover ends their membership (LEFT) and posts MEMBER_LEFT", async () => {
    const { service, memberRepo, sysMsg, roomRepo } = makeService(["next"], [true]);

    await expect(service.autoSucceed(ROOM, "lead", true)).resolves.toBe(true);
    expect(memberRepo.transferLeadership).toHaveBeenCalledWith(
      ROOM,
      "lead",
      "next",
      expect.any(Date)
    );
    expect(roomRepo.incMemberCount).toHaveBeenCalledWith(ROOM, -1);
    expect(sysMsg.post.mock.calls.map((c) => c[0].systemEvent)).toEqual([
      "LEADER_CHANGED",
      "MEMBER_LEFT",
    ]);
  });

  it("promotes the longest-standing member and posts LEADER_CHANGED {auto}", async () => {
    const { service, memberRepo, sysMsg } = makeService(["oldest", "newer"], [true]);

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBe(true);
    expect(memberRepo.transferLeadership).toHaveBeenCalledWith(ROOM, "lead", "oldest");
    expect(sysMsg.post).toHaveBeenCalledWith({
      roomId: ROOM,
      actorId: null,
      systemEvent: "LEADER_CHANGED",
      systemData: { targetUserId: "oldest", targetId: "oldest", auto: true },
    });
  });

  it("falls through to the next candidate when the first left mid-handover", async () => {
    const { service, memberRepo } = makeService(["gone", "next"], [false, true]);

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBe(true);
    expect(memberRepo.transferLeadership).toHaveBeenLastCalledWith(ROOM, "lead", "next");
  });

  it("nobody to promote → null (caller keeps last-member behaviour)", async () => {
    const { service, sysMsg } = makeService([], []);

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBeNull();
    expect(sysMsg.post).not.toHaveBeenCalled();
  });

  it("leader already replaced (lost race) → false, no line", async () => {
    const { service, sysMsg } = makeService(["a"], [false]);

    await expect(service.autoSucceed(ROOM, "lead")).resolves.toBe(false);
    expect(sysMsg.post).not.toHaveBeenCalled();
  });

  it("autoSucceedEverywhere reports only the groups with nobody to promote", async () => {
    const { service, memberRepo } = makeService([], []);
    memberRepo.findRoomIdsByOwnerUserIds.mockResolvedValue(["r-solo", "r-team"]);
    memberRepo.findSuccessionCandidates.mockImplementation(async (roomId: string) =>
      roomId === "r-team" ? ["m1"] : []
    );
    memberRepo.transferLeadership.mockResolvedValue(true);

    await expect(service.autoSucceedEverywhere("lead")).resolves.toEqual(["r-solo"]);
  });
});

describe("GroupMemberService.leave — deleted accounts are not successors", () => {
  function makeLeaveService(candidates: string[], deleted: string[]) {
    const memberRepo = {
      findActiveByRoomAndUser: jest.fn().mockResolvedValue({ userId: "lead", role: "ADMIN" }),
      findSuccessionCandidates: jest.fn().mockResolvedValue(candidates),
      countActiveMembers: jest.fn().mockResolvedValue(candidates.length + 1),
      transferLeadership: jest.fn().mockResolvedValue(true),
      findByRoomAndUser: jest.fn().mockResolvedValue({ status: "LEFT" }),
      findActiveMembers: jest.fn().mockResolvedValue([]),
    };
    const disbander = { disbandGroup: jest.fn().mockResolvedValue({}) };
    const service = new GroupMemberService(
      memberRepo as never,
      {
        findActiveByRoomId: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
        incMemberCount: jest.fn(),
      } as never,
      { post: jest.fn().mockResolvedValue(undefined) } as never,
      { publish: jest.fn().mockResolvedValue(0), get: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      {
        getUserSnapshotsMap: jest.fn().mockResolvedValue(
          new Map(deleted.map((id) => [id, { userId: id, memberId: "", isDeletedUser: true }]))
        ),
      } as never,
      {} as never,
      disbander
    );
    return { service, memberRepo, disbander };
  }

  it("only deleted accounts left → no successor needed; leaving closes the group", async () => {
    const { service, memberRepo, disbander } = makeLeaveService(["gone-1", "gone-2"], ["gone-1", "gone-2"]);

    await service.leave(ROOM, "lead");

    expect(disbander.disbandGroup).toHaveBeenCalledWith(ROOM, "lead", { asLastMember: false });
    expect(memberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("a deleted successor is refused with 409", async () => {
    const { service, memberRepo } = makeLeaveService(["gone-1", "ok-1"], ["gone-1"]);

    await expect(service.leave(ROOM, "lead", undefined, "gone-1")).rejects.toMatchObject({
      messageKey: "CHAT_LEADER_SUCCESSOR_REQUIRED",
    });
    expect(memberRepo.transferLeadership).not.toHaveBeenCalled();
  });

  it("an eligible member remains → 409 without a successor", async () => {
    const { service, disbander } = makeLeaveService(["gone-1", "ok-1"], ["gone-1"]);

    await expect(service.leave(ROOM, "lead")).rejects.toMatchObject({
      messageKey: "CHAT_LEADER_SUCCESSOR_REQUIRED",
    });
    expect(disbander.disbandGroup).not.toHaveBeenCalled();
  });
});

describe("concurrent handovers", () => {
  it("two handovers at once → exactly one leader, the loser is refused", async () => {
    const roles: Record<string, string> = { lead: "ADMIN", a: "MEMBER", b: "MEMBER" };
    const memberRepo = {
      findActiveByRoomAndUser: jest.fn(async (_r: string, u: string) =>
        roles[u] ? { userId: u, role: roles[u], status: "ACTIVE" } : null
      ),
      // The repository's conditional write: `from` must still lead, `to` must not.
      transferLeadership: jest.fn(async (_r: string, from: string, to: string) => {
        await Promise.resolve();
        if (roles[from] !== "ADMIN" || roles[to] === "ADMIN") return false;
        roles[from] = "MEMBER";
        roles[to] = "ADMIN";
        return true;
      }),
      findByRoomAndUser: jest.fn(async (_r: string, u: string) => ({ userId: u, role: roles[u] })),
      findActiveMembers: jest.fn().mockResolvedValue([]),
    };
    const service = new GroupMemberService(
      memberRepo as never,
      { findActiveByRoomId: jest.fn().mockResolvedValue(null) } as never,
      { post: jest.fn().mockResolvedValue(undefined) } as never,
      { publish: jest.fn().mockResolvedValue(0) } as never
    );
    const handover = (target: string) =>
      service.updateRole({ roomId: ROOM, targetUserId: target, newRole: "ADMIN", actorUserId: "lead" });

    const results = await Promise.allSettled([handover("a"), handover("b")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { messageKey: "CHAT_INSUFFICIENT_PERMISSIONS" },
    });
    expect(Object.values(roles).filter((r) => r === "ADMIN")).toHaveLength(1);
  });
});

describe("AdminGroupService.adminApplySystemBan", () => {
  it("hands groups over and closes only the ones with nobody left", async () => {
    const closeGroupForSystemBan = jest.fn(async (roomId: string) => ({ roomId }));
    const autoSucceedEverywhere = jest.fn().mockResolvedValue(["r-solo"]);
    const service = new AdminGroupService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { closeGroupForSystemBan } as never,
      { autoSucceedEverywhere } as never
    );

    await expect(service.adminApplySystemBan("lead", "bo-1")).resolves.toEqual({
      closedGroupIds: ["r-solo"],
      removedGroupIds: [],
    });
    expect(autoSucceedEverywhere).toHaveBeenCalledWith("lead");
    expect(closeGroupForSystemBan).toHaveBeenCalledTimes(1);
  });
});

describe("migrate-group-leader-members mapping", () => {
  it("MODERATOR → MEMBER, matching only rows still MODERATOR", () => {
    expect(MODERATOR_WHERE).toEqual({ role: "MODERATOR" });
    expect(MODERATOR_DATA).toEqual({ role: "MEMBER" });
  });

  it("clears every moderation-mute column, matching only rows still carrying one", () => {
    expect(MUTED_DATA).toEqual({
      moderationMuted: false,
      moderationMutedUntil: null,
      moderationMutedBy: null,
    });
    expect(MUTED_WHERE.OR).toHaveLength(3);
  });

  it("BANNED → KICKED keeps who/when on the kick columns and clears the ban", () => {
    const bannedAt = new Date("2026-01-01T00:00:00Z");
    expect(BANNED_WHERE).toEqual({ status: "BANNED" });
    expect(
      bannedToKicked({ bannedAt, bannedBy: "lead", updatedAt: new Date() })
    ).toEqual({
      status: "KICKED",
      kickedAt: bannedAt,
      kickedBy: "lead",
      bannedAt: null,
      bannedBy: null,
    });
    const updatedAt = new Date("2026-02-01T00:00:00Z");
    expect(
      bannedToKicked({ bannedAt: null, bannedBy: null, updatedAt }).kickedAt
    ).toBe(updatedAt);
  });

  it("closure snapshots: BANNED → KICKED with the ban stamp cleared", () => {
    expect(CLOSURE_BANNED_DATA).toEqual({ status: "KICKED", bannedAt: null });
  });
});

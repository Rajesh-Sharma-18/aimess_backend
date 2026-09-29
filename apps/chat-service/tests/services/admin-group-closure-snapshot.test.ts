/**
 * A closed group's admin view is the roster frozen at closure, never the live
 * one: a disband ends every membership (live count 0), and later leave / kick /
 * account changes must not move it. An ACTIVE group keeps the live roster.
 */
import { AdminGroupService } from "../../src/services/admin-group.service.js";

function makeService(room: Record<string, unknown>) {
  const groupRoomRepo = {
    adminFindByRoomId: jest.fn().mockResolvedValue({
      roomId: "r1",
      avatar: "",
      createdBy: "owner",
      createdAt: new Date(0),
      ...room,
    }),
  };
  const groupMemberRepo = {
    findOwnersForRooms: jest.fn().mockResolvedValue(new Map()),
    countRosterMembers: jest.fn().mockResolvedValue(0),
    adminListMembers: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    adminListClosureMembers: jest.fn().mockResolvedValue({
      rows: [
        {
          userId: "u1",
          username: "alice_at_close",
          displayName: "Alice",
          avatar: "",
          role: "ADMIN",
          status: "ACTIVE",
          joinedAt: new Date(1000),
          bannedAt: null,
        },
      ],
      total: 4,
    }),
  };
  const service = new AdminGroupService(
    groupRoomRepo as never,
    groupMemberRepo as never,
    {
      getUserSnapshotsMap: jest
        .fn()
        .mockResolvedValue(new Map([["u1", { memberId: "alice_renamed" }]])),
    } as never,
    {} as never,
    {
      searchUserIds: jest.fn().mockResolvedValue([]),
      resolveUsersByIds: jest.fn().mockResolvedValue(new Map()),
    } as never,
    {} as never,
    {} as never
  );
  return { service, groupMemberRepo };
}

describe("AdminGroupService closure snapshot", () => {
  it("closed group: count and list come from the snapshot", async () => {
    const { service, groupMemberRepo } = makeService({
      status: "DISBANDED",
      memberCountAtClosure: 4,
    });

    const { group } = await service.getGroup("r1");
    expect(group?.memberCount).toBe(4);
    expect(groupMemberRepo.countRosterMembers).not.toHaveBeenCalled();

    const res = await service.listGroupMembers({
      groupId: "r1",
      skip: 0,
      take: 20,
    });
    expect(res.total).toBe(4);
    expect(groupMemberRepo.adminListMembers).not.toHaveBeenCalled();
    // The name the group knew at closure, not today's rename.
    expect(res.members[0]).toMatchObject({
      userId: "u1",
      username: "alice_at_close",
      role: "ADMIN",
      status: "ACTIVE",
      joinedAt: 1000,
    });
  });

  it("active group (or legacy closed group with no snapshot): live roster", async () => {
    for (const room of [
      { status: "ACTIVE", memberCountAtClosure: null },
      { status: "DISBANDED", memberCountAtClosure: null },
    ]) {
      const { service, groupMemberRepo } = makeService(room);
      groupMemberRepo.countRosterMembers.mockResolvedValue(7);

      expect((await service.getGroup("r1")).group?.memberCount).toBe(7);
      await service.listGroupMembers({ groupId: "r1", skip: 0, take: 20 });
      expect(groupMemberRepo.adminListMembers).toHaveBeenCalled();
      expect(groupMemberRepo.adminListClosureMembers).not.toHaveBeenCalled();
    }
  });
});

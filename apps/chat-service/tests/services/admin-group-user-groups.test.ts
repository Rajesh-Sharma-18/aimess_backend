import { AdminGroupService } from "../../src/services/admin-group.service.js";

function makeService(memberships: unknown[], rooms: unknown[], total: number) {
  const groupRoomRepo = {
    searchInRoomIds: jest.fn().mockResolvedValue(rooms),
    countUserGroups: jest.fn().mockResolvedValue(total),
    adminFindByRoomId: jest
      .fn()
      .mockResolvedValue({ roomId: "r1", status: "ACTIVE", avatar: "" }),
  };
  const groupMemberRepo = {
    getActiveMemberships: jest.fn().mockResolvedValue(memberships),
    countRosterMembersForRooms: jest
      .fn()
      .mockResolvedValue(new Map([["r1", 7]])),
    adminListMembers: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  };
  const service = new AdminGroupService(
    groupRoomRepo as never,
    groupMemberRepo as never,
    { getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    {
      searchUserIds: jest.fn().mockResolvedValue([]),
      resolveUsersByIds: jest.fn().mockResolvedValue(new Map()),
    } as never,
    {} as never,
    {} as never
  );
  return { service, groupRoomRepo, groupMemberRepo };
}

describe("AdminGroupService.listUserGroups", () => {
  it("returns an empty page without touching rooms when the user has no memberships", async () => {
    const { service, groupRoomRepo } = makeService([], [], 0);

    const result = await service.listUserGroups({ userId: "u1", skip: 0, take: 20 });

    expect(result).toEqual({ groups: [], total: 0 });
    expect(groupRoomRepo.searchInRoomIds).not.toHaveBeenCalled();
  });

  it("stamps the viewed user's role and join date and the live roster count", async () => {
    const joinedAt = new Date("2026-01-02T00:00:00Z");
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const { service, groupRoomRepo } = makeService(
      [{ roomId: "r1", role: "MODERATOR", joinedAt }],
      [
        {
          roomId: "r1",
          name: "Team",
          avatar: "",
          description: "desc",
          memberCount: 99,
          memberLimit: 256,
          createdAt,
          status: "ACTIVE",
          memberCountAtClosure: null,
        },
      ],
      1
    );

    const result = await service.listUserGroups({ userId: "u1", skip: 20, take: 20 });

    expect(groupRoomRepo.searchInRoomIds).toHaveBeenCalledWith(["r1"], undefined, 20, 20);
    expect(result.total).toBe(1);
    expect(result.groups[0]).toMatchObject({
      id: "r1",
      name: "Team",
      description: "desc",
      memberCount: 7,
      memberLimit: 256,
      status: "ACTIVE",
      role: "MODERATOR",
      joinedAt: joinedAt.getTime(),
      createdAt: createdAt.getTime(),
    });
  });

  it("forwards excludeUserId to the member query", async () => {
    const { service, groupMemberRepo } = makeService([], [], 0);

    await service.listGroupMembers({ groupId: "r1", excludeUserId: "u1", skip: 0, take: 20 });

    expect(groupMemberRepo.adminListMembers).toHaveBeenCalledWith(
      expect.objectContaining({ excludeUserId: "u1" })
    );
  });
});

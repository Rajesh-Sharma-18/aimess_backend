/**
 * Admin group/member search must match the username the panel RENDERS (which
 * lives in user-service), not only auth-service's email/account columns. This
 * pins the union of both identity backends — it fails the moment either leg is
 * dropped from the candidate set.
 */
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";
import { AdminGroupService } from "../../src/services/admin-group.service.js";

function makeService(over: {
  groupRoomRepo?: Record<string, unknown>;
  groupMemberRepo?: Record<string, unknown>;
  authAdminClient?: Record<string, unknown>;
}) {
  const groupRoomRepo = {
    adminFindByRoomId: jest
      .fn()
      .mockResolvedValue({ roomId: "r1", avatar: "" }),
    adminList: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    ...(over.groupRoomRepo ?? {}),
  };
  const groupMemberRepo = {
    adminListMembers: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    findRoomIdsByOwnerUserIds: jest.fn().mockResolvedValue(["r1"]),
    findOwnersForRooms: jest.fn().mockResolvedValue(new Map()),
    ...(over.groupMemberRepo ?? {}),
  };
  const userSnapshotService = {
    getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()),
  };
  const authAdminClient = {
    searchUserIds: jest.fn().mockResolvedValue([]),
    resolveUsersByIds: jest.fn().mockResolvedValue(new Map()),
    ...(over.authAdminClient ?? {}),
  };
  const service = new AdminGroupService(
    groupRoomRepo as never,
    groupMemberRepo as never,
    userSnapshotService as never,
    {} as never,
    authAdminClient as never,
    {} as never,
    {} as never
  );
  return { service, groupRoomRepo, groupMemberRepo, authAdminClient };
}

describe("AdminGroupService identity search union", () => {
  it("listGroupMembers keeps a username-only match that auth-service misses", async () => {
    (userGrpcClient.adminSearchProfileIds as jest.Mock).mockResolvedValue([
      "u1",
    ]);
    const { service, groupMemberRepo } = makeService({});

    await service.listGroupMembers({
      groupId: "r1",
      q: "john",
      skip: 0,
      take: 20,
    });

    expect(groupMemberRepo.adminListMembers).toHaveBeenCalledWith(
      expect.objectContaining({ userIdsFromSearch: ["u1"] })
    );
  });

  it("listGroups dedupes ids found by BOTH backends", async () => {
    (userGrpcClient.adminSearchProfileIds as jest.Mock).mockResolvedValue([
      "u1",
      "u2",
    ]);
    const { service, groupMemberRepo } = makeService({
      authAdminClient: { searchUserIds: jest.fn().mockResolvedValue(["u1"]) },
    });

    await service.listGroups({
      q: "john",
      sortField: "createdAt",
      sortDir: "desc",
      skip: 0,
      take: 20,
    });

    expect(groupMemberRepo.findRoomIdsByOwnerUserIds).toHaveBeenCalledWith([
      "u1",
      "u2",
    ]);
  });
});

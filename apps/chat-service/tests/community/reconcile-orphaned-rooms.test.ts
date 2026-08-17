/**
 * The reconciler used to iterate ONLY the communities community-service returns,
 * so a room whose community row is gone entirely (hard delete, dropped
 * collection, restore from an older snapshot) was never looked at: it stayed
 * `active` with `active` RoomMember rows, and the Community nav badge — which
 * sums unread over those rows — counted unread for a conversation
 * `/communities/mine` no longer lists and the user therefore cannot open or
 * clear.
 *
 * `c.deleted` does NOT cover this: that flag only describes a community
 * community-service still lists (soft-deleted, `deletedAt` set).
 */
const deactivateForCommunity = jest.fn(async () => {});
const markAllLeft = jest.fn(async () => {});
const provisionForCommunity = jest.fn(async () => {});
const setCommunityType = jest.fn(async () => {});
const upsert = jest.fn(async () => {});
const listAllIdsWithStatus = jest.fn();
const listCommunities = jest.fn();

jest.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
jest.mock("../../src/config/env.js", () => ({
  env: { COMMUNITY_ROOM_RECONCILE_ENABLED: true },
}));
jest.mock("../../src/repositories/general-room.repository.js", () => ({
  GeneralRoomRepository: class {
    listAllIdsWithStatus = listAllIdsWithStatus;
    deactivateForCommunity = deactivateForCommunity;
    provisionForCommunity = provisionForCommunity;
    setCommunityType = setCommunityType;
  },
}));
jest.mock("../../src/repositories/room-member.repository.js", () => ({
  RoomMemberRepository: class {
    markAllLeft = markAllLeft;
    upsert = upsert;
  },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  createCommunityReconcileClient: () => ({ listCommunities }),
}));
jest.mock("../../src/events/community-room-sync.consumer.js", () => ({
  buildRoomMemberSyncData: () => ({ status: "active" }),
}));

import { reconcileCommunityRooms } from "../../src/startup/reconcile-community-rooms.js";

const ORPHAN = "room-with-no-community";
const LIVE = "room-with-live-community";

beforeEach(() => {
  jest.clearAllMocks();
  (listAllIdsWithStatus as jest.Mock).mockResolvedValue([
    { id: LIVE, status: "active" },
    { id: ORPHAN, status: "active" },
    { id: "already-inactive", status: "inactive" },
  ]);
});

describe("reconcileCommunityRooms — rooms with no community record", () => {
  it("deactivates the orphan and leaves the live room alone", async () => {
    (listCommunities as jest.Mock).mockResolvedValue({
      communities: [
        {
          id: LIVE,
          deleted: false,
          communityType: "PUBLIC",
          name: "Live",
          adminId: "a",
          avatarUrl: "",
          members: [],
        },
      ],
      hasMore: false,
      nextAfterId: "",
    });

    await reconcileCommunityRooms();

    expect(deactivateForCommunity).toHaveBeenCalledWith(ORPHAN);
    expect(markAllLeft).toHaveBeenCalledWith(ORPHAN);
    expect(deactivateForCommunity).not.toHaveBeenCalledWith(LIVE);
    // An already-inactive room needs no second write.
    expect(deactivateForCommunity).not.toHaveBeenCalledWith("already-inactive");
    expect(deactivateForCommunity).toHaveBeenCalledTimes(1);
  });

  it("touches nothing when the scan was truncated", async () => {
    // A partial community list makes every unscanned community's room look
    // orphaned; deactivating on that basis would take down live chats.
    (listCommunities as jest.Mock).mockResolvedValue({
      communities: [],
      hasMore: true,
      nextAfterId: "",
    });

    await reconcileCommunityRooms();

    expect(deactivateForCommunity).not.toHaveBeenCalled();
    expect(markAllLeft).not.toHaveBeenCalled();
  });
});

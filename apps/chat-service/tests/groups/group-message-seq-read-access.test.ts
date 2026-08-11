/**
 * `getMessagesSeq` / `getMessagesAround` — the ACTUAL methods the group
 * timeline route (`GET /api/chat/groups/:roomId/messages`, no
 * around/before_seq/after_seq → seq page; `?around=` → getMessagesAround)
 * calls, per `GroupMessageController.listMessages`.
 *
 * Root-cause regression test: an earlier pass widened `getMessagesTimeline`
 * (the `before_ts`/`after_ts` timestamp path) from `assertGroupMember`
 * to `assertGroupReadAccess` so a LEFT member could keep reading history up
 * to when they left — but the frontend's `getGroupMessages` actually calls
 * the SEQ-based read path, which still 403'd every LEFT member because
 * `getMessagesSeq`/`getMessagesAround` were still on the old ACTIVE-only
 * `assertGroupMember` guard. This file pins both seq-based methods to the
 * same read-access contract so this exact class of bug (right guard, wrong
 * overload) can't silently reappear.
 */
import { ForbiddenError } from "@aimess/errors";
import { GroupMessageService } from "../../src/services/group-message.service.js";

const ROOM_ID = "grp_room_1";
const USER_ID = "usr_1";

function buildService() {
  const findByRoomIdSeq = jest.fn().mockResolvedValue([]);
  const findAroundSeq = jest.fn().mockResolvedValue([]);
  const findById = jest.fn().mockResolvedValue({ id: "m1", sequenceNumber: 5 });
  const messageRepo = {
    findByRoomIdSeq,
    findAroundSeq,
    findById,
  } as unknown as import("../../src/repositories/group-message.repository.js").GroupMessageRepository;

  const getRoomRevision = jest.fn().mockResolvedValue(1);
  const roomRepo = {
    getRoomRevision,
  } as unknown as import("../../src/repositories/group-room.repository.js").GroupRoomRepository;

  const findByRoomAndUser = jest.fn();
  const memberRepo = {
    findByRoomAndUser,
  } as unknown as import("../../src/repositories/group-member.repository.js").GroupMemberRepository;

  const cacheRepo =
    {} as import("../../src/repositories/cache.repository.js").CacheRepository;
  const userSnapshotService =
    {} as import("../../src/services/user-snapshot.service.js").UserSnapshotService;

  const service = new GroupMessageService(
    messageRepo,
    roomRepo,
    memberRepo,
    cacheRepo,
    userSnapshotService
  );

  return {
    service,
    findByRoomIdSeq,
    findAroundSeq,
    findById,
    findByRoomAndUser,
  };
}

describe("GroupMessageService.getMessagesSeq — read access", () => {
  it("ACTIVE member: succeeds with no readCutoffBefore", async () => {
    const { service, findByRoomIdSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
      joinedAt: null,
      clearedAt: null,
    });

    await service.getMessagesSeq({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      seq: null,
      limit: 20,
    });

    expect(findByRoomIdSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: undefined })
    );
  });

  it("LEFT member: succeeds (not 403) and clamps to readCutoffBefore=leftAt", async () => {
    const leftAt = new Date("2026-07-01T00:00:00Z");
    const { service, findByRoomIdSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt,
      joinedAt: null,
      clearedAt: null,
    });

    await service.getMessagesSeq({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      seq: null,
      limit: 20,
    });

    expect(findByRoomIdSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: leftAt })
    );
  });

  it("KICKED member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({ status: "KICKED" });

    await expect(
      service.getMessagesSeq({
        roomId: ROOM_ID,
        userId: USER_ID,
        direction: "before",
        seq: null,
        limit: 20,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never a member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue(null);

    await expect(
      service.getMessagesSeq({
        roomId: ROOM_ID,
        userId: USER_ID,
        direction: "before",
        seq: null,
        limit: 20,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("GroupMessageService.getMessagesAround — read access", () => {
  it("LEFT member: succeeds (not 403) and clamps to readCutoffBefore=leftAt", async () => {
    const leftAt = new Date("2026-07-01T00:00:00Z");
    const { service, findAroundSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt,
      joinedAt: null,
      clearedAt: null,
    });

    await service.getMessagesAround({
      roomId: ROOM_ID,
      userId: USER_ID,
      messageId: "m1",
      limit: 20,
    });

    expect(findAroundSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: leftAt })
    );
  });

  it("BANNED member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({ status: "BANNED" });

    await expect(
      service.getMessagesAround({
        roomId: ROOM_ID,
        userId: USER_ID,
        messageId: "m1",
        limit: 20,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

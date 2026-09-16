/**
 * `getMessagesSeq` / `getMessagesAround` — the ACTUAL methods the group
 * timeline route (`GET /api/chat/groups/rooms/:roomId/messages`, no
 * around/before_seq/after_seq → seq page; `?around=` → getMessagesAround)
 * calls, per `GroupMessageController.listMessages`.
 *
 * Root-cause regression test for a "right guard, wrong overload" bug: the two
 * SEQ-based reads are the ones the frontend actually calls, so they must carry
 * the SAME read-access contract as the timestamp path — never a looser or a
 * stricter one of their own.
 *
 * The contract they pin: a membership that has ENDED (LEFT, KICKED, BANNED)
 * reads nothing, because the group is gone from that user's list and must not
 * be reachable by roomId either. The one exception is a room a DISBAND killed,
 * where every membership was ended at the room's own `disbandedAt` and an open
 * client still has to render the history it holds.
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
  // Live room by default — the read guard consults it only for a membership
  // that has already ended.
  const findByRoomId = jest
    .fn()
    .mockResolvedValue({ roomId: ROOM_ID, status: "ACTIVE" });
  const roomRepo = {
    getRoomRevision,
    findByRoomId,
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
    findByRoomId,
  };
}

const readSeq = (service: GroupMessageService) =>
  service.getMessagesSeq({
    roomId: ROOM_ID,
    userId: USER_ID,
    direction: "before",
    seq: null,
    limit: 20,
  });

const readAround = (service: GroupMessageService) =>
  service.getMessagesAround({
    roomId: ROOM_ID,
    userId: USER_ID,
    messageId: "m1",
    limit: 20,
  });

describe("GroupMessageService.getMessagesSeq — read access", () => {
  it("ACTIVE member: succeeds with no readCutoffBefore", async () => {
    const { service, findByRoomIdSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "ACTIVE",
      joinedAt: null,
      clearedAt: null,
    });

    await readSeq(service);

    expect(findByRoomIdSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: undefined })
    );
  });

  it("LEFT member: rejected — leaving ends access to the history too", async () => {
    const { service, findByRoomIdSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt: new Date("2026-07-01T00:00:00Z"),
      joinedAt: null,
      clearedAt: null,
    });

    await expect(readSeq(service)).rejects.toBeInstanceOf(ForbiddenError);
    expect(findByRoomIdSeq).not.toHaveBeenCalled();
  });

  it("KICKED member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "KICKED",
      kickedAt: new Date("2026-07-01T00:00:00Z"),
    });

    await expect(readSeq(service)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never a member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue(null);

    await expect(readSeq(service)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("DISBANDED room: still readable, clamped to the disband instant", async () => {
    const disbandedAt = new Date("2026-07-01T00:00:00Z");
    const { service, findByRoomIdSeq, findByRoomAndUser, findByRoomId } =
      buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt: disbandedAt,
      joinedAt: null,
      clearedAt: null,
    });
    findByRoomId.mockResolvedValue({
      roomId: ROOM_ID,
      status: "DISBANDED",
      disbandedAt,
    });

    await readSeq(service);

    expect(findByRoomIdSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: disbandedAt })
    );
  });
});

describe("GroupMessageService.getMessagesAround — read access", () => {
  it("LEFT member: rejected", async () => {
    const { service, findAroundSeq, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt: new Date("2026-07-01T00:00:00Z"),
      joinedAt: null,
      clearedAt: null,
    });

    await expect(readAround(service)).rejects.toBeInstanceOf(ForbiddenError);
    expect(findAroundSeq).not.toHaveBeenCalled();
  });

  it("BANNED member: rejected", async () => {
    const { service, findByRoomAndUser } = buildService();
    findByRoomAndUser.mockResolvedValue({ status: "BANNED" });

    await expect(readAround(service)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("DISBANDED room: still readable, clamped to the disband instant", async () => {
    const disbandedAt = new Date("2026-07-01T00:00:00Z");
    const { service, findAroundSeq, findByRoomAndUser, findByRoomId } =
      buildService();
    findByRoomAndUser.mockResolvedValue({
      status: "LEFT",
      leftAt: disbandedAt,
      joinedAt: null,
      clearedAt: null,
    });
    findByRoomId.mockResolvedValue({
      roomId: ROOM_ID,
      status: "DISBANDED",
      disbandedAt,
    });

    await readAround(service);

    expect(findAroundSeq).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: disbandedAt })
    );
  });
});

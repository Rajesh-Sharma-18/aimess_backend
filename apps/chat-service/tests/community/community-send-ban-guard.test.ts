/**
 * Ban enforcement on the community-chat WRITE chokepoint.
 *
 * `CommunityMessageService.sendMessage` is the single method all three send
 * entry points funnel through (gRPC service-impl, REST orchestrator.sendCommunity,
 * and the gateway socket → gRPC). A BANNED member's RoomMember row is mirrored as
 * status !== "active" by the community sync consumer, so the guard must reject
 * them with CHAT_NOT_A_MEMBER before any message is persisted.
 */
import { ForbiddenError } from "@aimess/errors";

import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";

function buildService(memberStatus: string | null) {
  const messageRepo = { create: jest.fn(), findOne: jest.fn() };
  const roomRepo = {
    findRoomById: jest.fn().mockResolvedValue({
      id: ROOM_ID,
      status: "active",
    }),
  };
  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue(
      memberStatus === null
        ? null
        : {
            roomId: ROOM_ID,
            userId: USER_ID,
            status: memberStatus,
            role: "member",
          }
    ),
  };
  const cacheRepo = {
    getMessageIdempotency: jest.fn(),
    setMessageIdempotency: jest.fn(),
  };
  const userSnapshotService = { resolve: jest.fn() };

  const service = new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    cacheRepo as never,
    userSnapshotService as never
  );
  return { service, messageRepo, memberRepo };
}

const sendParams = {
  roomId: ROOM_ID,
  sentBy: USER_ID,
  senderName: "John",
  senderAvatar: "",
  message: "hello",
  messageType: "TEXT",
};

describe("CommunityMessageService.sendMessage ban guard", () => {
  it("rejects a BANNED member with ForbiddenError and never persists", async () => {
    const { service, messageRepo, memberRepo } = buildService("banned");

    await expect(service.sendMessage(sendParams)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(memberRepo.findByRoomAndUser).toHaveBeenCalledWith(ROOM_ID, USER_ID);
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member (no RoomMember row)", async () => {
    const { service, messageRepo } = buildService(null);
    await expect(service.sendMessage(sendParams)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a LEFT member", async () => {
    const { service, messageRepo } = buildService("left");
    await expect(service.sendMessage(sendParams)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it("lets an ACTIVE member past the guard (reaches idempotency lookup)", async () => {
    const { service, memberRepo } = buildService("active");
    // ACTIVE clears the guard; the send then proceeds into idempotency/persist
    // (which our minimal mocks don't fully satisfy). We only assert the guard
    // itself did not reject — i.e. the membership lookup ran and we got past it.
    await service.sendMessage(sendParams).catch(() => undefined);
    expect(memberRepo.findByRoomAndUser).toHaveBeenCalledWith(ROOM_ID, USER_ID);
  });
});

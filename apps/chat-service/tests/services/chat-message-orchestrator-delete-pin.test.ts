/**
 * ChatMessageOrchestrator.deleteDirect / pinDirect / unpinDirect — new entry
 * points added for socket parity with community's community:message:delete /
 * pin / unpin. These wrap the SAME private/group services + redis broadcast
 * the REST delete/pin/unpin controllers already use, so gRPC/socket callers
 * get identical effects instead of a thinner duplicate.
 */
import { ChatMessageOrchestrator } from "../../src/services/chat-message-orchestrator.js";

const ROOM_ID = "r".repeat(24);
const MSG_ID = "m".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";

function buildOrchestrator() {
  const privateMessageService = {
    deleteForMe: jest.fn(),
    deleteForEveryone: jest.fn(),
    recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue(null),
    recalculateLastMessageAfterDeleteForMe: jest.fn().mockResolvedValue(null),
    resolveForEveryoneOverrides: jest.fn().mockResolvedValue(new Map()),
  };
  const groupMessageService = {
    deleteForMe: jest.fn(),
    deleteMessage: jest.fn(),
    recalculateLastMessageAfterDelete: jest.fn().mockResolvedValue(null),
    recalculateLastMessageAfterDeleteForMe: jest.fn().mockResolvedValue(null),
    resolveForEveryoneOverrides: jest.fn().mockResolvedValue(new Map()),
    getActiveMemberIds: jest.fn().mockResolvedValue([]),
  };
  const groupMemberService = {};
  const communityMessageService = {};
  const userSnapshotService = { getUserSnapshotsMap: jest.fn() };
  const cacheRepo = {};
  const redis = { publish: jest.fn().mockResolvedValue(undefined) };
  const privatePinService = {
    pin: jest.fn(),
    unpin: jest.fn(),
  };
  const groupPinService = {
    pin: jest.fn(),
    unpin: jest.fn(),
  };

  const orchestrator = new ChatMessageOrchestrator(
    privateMessageService as never,
    groupMessageService as never,
    groupMemberService as never,
    communityMessageService as never,
    userSnapshotService as never,
    cacheRepo as never,
    redis as never,
    privatePinService as never,
    groupPinService as never
  );

  return {
    orchestrator,
    privateMessageService,
    groupMessageService,
    privatePinService,
    groupPinService,
    redis,
  };
}

describe("ChatMessageOrchestrator.deleteDirect", () => {
  it("PRIVATE forMe: calls privateMessageService.deleteForMe and publishes message:delete", async () => {
    const { orchestrator, privateMessageService, redis } = buildOrchestrator();
    privateMessageService.deleteForMe.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
    });

    const { tombstone } = await orchestrator.deleteDirect({
      conversationType: "PRIVATE",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forMe",
    });

    expect(privateMessageService.deleteForMe).toHaveBeenCalledWith(
      MSG_ID,
      USER_ID
    );
    expect(tombstone).toMatchObject({
      messageId: MSG_ID,
      conversationId: ROOM_ID,
      type: "forMe",
    });
    expect(redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM_ID}`,
      expect.stringContaining("message:delete")
    );
  });

  it("GROUP forEveryone: calls groupMessageService.deleteMessage and publishes message:delete", async () => {
    const { orchestrator, groupMessageService, redis } = buildOrchestrator();
    groupMessageService.deleteMessage.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
      deletedType: "SELF_DELETE",
    });

    const { tombstone } = await orchestrator.deleteDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forEveryone",
    });

    expect(groupMessageService.deleteMessage).toHaveBeenCalledWith(
      MSG_ID,
      USER_ID,
      ROOM_ID
    );
    expect(tombstone).toMatchObject({
      messageId: MSG_ID,
      conversationId: ROOM_ID,
      type: "forEveryone",
    });
    expect(redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM_ID}`,
      expect.stringContaining("message:delete")
    );
  });

  it("throws NotFoundError when the underlying service returns null", async () => {
    const { orchestrator, groupMessageService } = buildOrchestrator();
    groupMessageService.deleteForMe.mockResolvedValue(null);

    await expect(
      orchestrator.deleteDirect({
        conversationType: "GROUP",
        roomId: ROOM_ID,
        messageId: MSG_ID,
        userId: USER_ID,
        scope: "forMe",
      })
    ).rejects.toThrow();
  });
});

describe("ChatMessageOrchestrator.pinDirect / unpinDirect", () => {
  it("PRIVATE pin: calls privatePinService.pin and publishes pin:updated", async () => {
    const { orchestrator, privatePinService, redis } = buildOrchestrator();
    privatePinService.pin.mockResolvedValue({
      pin: { pinnedAt: new Date() },
      pinnedCount: 1,
    });

    const result = await orchestrator.pinDirect({
      conversationType: "PRIVATE",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });

    expect(privatePinService.pin).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });
    expect(result.pinnedCount).toBe(1);
    expect(redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM_ID}`,
      expect.stringContaining("pin:updated")
    );
  });

  it("GROUP unpin: calls groupPinService.unpin and publishes pin:updated", async () => {
    const { orchestrator, groupPinService, redis } = buildOrchestrator();
    groupPinService.unpin.mockResolvedValue({ pinnedCount: 0 });

    const result = await orchestrator.unpinDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });

    expect(groupPinService.unpin).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });
    expect(result.pinnedCount).toBe(0);
    expect(redis.publish).toHaveBeenCalledWith(
      `conv:${ROOM_ID}`,
      expect.stringContaining("unpinned")
    );
  });
});

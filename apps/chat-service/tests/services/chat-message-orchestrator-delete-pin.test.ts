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
    unpinDeletedMessage: jest.fn().mockResolvedValue(null),
    findActivePinRoomId: jest.fn().mockResolvedValue(null),
  };
  const groupPinService = {
    pin: jest.fn(),
    unpin: jest.fn(),
    unpinDeletedMessage: jest.fn().mockResolvedValue(null),
    findActivePinRoomId: jest.fn().mockResolvedValue(null),
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

    // `bySystem: false` — a user-initiated delete keeps every actor check. Only
    // the auto-delete sweeper passes true (see tests/groups/group-auto-delete).
    expect(groupMessageService.deleteMessage).toHaveBeenCalledWith(
      MSG_ID,
      USER_ID,
      ROOM_ID,
      false
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

  // The pin hook is fire-and-forget inside deleteDirect — let its microtasks drain.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("forEveryone on a PINNED message unpins it for EVERYONE (conv:<roomId>)", async () => {
    const { orchestrator, privateMessageService, privatePinService, redis } =
      buildOrchestrator();
    privateMessageService.deleteForEveryone.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
    });
    privatePinService.unpinDeletedMessage.mockResolvedValue({
      roomId: ROOM_ID,
      pinnedCount: 0,
    });

    await orchestrator.deleteDirect({
      conversationType: "PRIVATE",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forEveryone",
    });
    await settle();

    expect(privatePinService.unpinDeletedMessage).toHaveBeenCalledWith(
      MSG_ID,
      USER_ID
    );
    const pinPublish = redis.publish.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("pin:updated")
    );
    expect(pinPublish?.[0]).toBe(`conv:${ROOM_ID}`);
    expect(JSON.parse(String(pinPublish?.[1])).data).toMatchObject({
      messageId: MSG_ID,
      action: "unpinned",
      pinnedCount: 0,
    });
  });

  it("forMe on a PINNED message unpins for the ACTOR ONLY (user:<id>), leaving the pin row intact", async () => {
    const { orchestrator, groupMessageService, groupPinService, redis } =
      buildOrchestrator();
    groupMessageService.deleteForMe.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
    });
    groupPinService.findActivePinRoomId.mockResolvedValue(ROOM_ID);

    await orchestrator.deleteDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forMe",
    });
    await settle();

    // The pin row itself must NOT be touched — every other member keeps it.
    expect(groupPinService.unpinDeletedMessage).not.toHaveBeenCalled();
    const pinPublish = redis.publish.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("pin:updated")
    );
    // Actor's own channel only — never conv:<roomId>, which is every member.
    expect(pinPublish?.[0]).toBe(`user:${USER_ID}`);
    expect(JSON.parse(String(pinPublish?.[1])).data).toMatchObject({
      messageId: MSG_ID,
      action: "unpinned",
    });
  });

  it("publishes no pin event when the deleted message was not pinned", async () => {
    const { orchestrator, privateMessageService, redis } = buildOrchestrator();
    privateMessageService.deleteForEveryone.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
    });

    await orchestrator.deleteDirect({
      conversationType: "PRIVATE",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forEveryone",
    });
    await settle();

    expect(
      redis.publish.mock.calls.filter((c: unknown[]) =>
        String(c[1]).includes("pin:updated")
      )
    ).toHaveLength(0);
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

describe("pin-line retraction keeps the last-message snapshot honest", () => {
  const SYS_PIN = "s".repeat(24);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("deleteDirect forEveryone recalculates only AFTER the pin hook has retracted the pin line", async () => {
    const { orchestrator, groupMessageService, groupPinService } =
      buildOrchestrator();
    const order: string[] = [];
    groupMessageService.deleteMessage.mockResolvedValue({
      id: MSG_ID,
      roomId: ROOM_ID,
      sequenceNumber: 5,
      createdAt: new Date(),
      deletedType: "ADMIN_DELETE",
    });
    // The retraction is a DB round trip — it must not be raced by the recalc,
    // or the snapshot is re-pinned to a line that is about to be tombstoned.
    groupPinService.unpinDeletedMessage.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("retract");
      return { roomId: ROOM_ID, pinnedCount: 0 };
    });
    groupMessageService.recalculateLastMessageAfterDelete.mockImplementation(
      async () => {
        order.push("recalc");
        return null;
      }
    );

    await orchestrator.deleteDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      scope: "forEveryone",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual(["retract", "recalc"]);
  });

  it("unpinDirect repairs the snapshot when the unpin retracted a pin line", async () => {
    const { orchestrator, groupMessageService, groupPinService } =
      buildOrchestrator();
    groupPinService.unpin.mockResolvedValue({
      pinnedCount: 0,
      retractedSystemMessageId: SYS_PIN,
    });

    await orchestrator.unpinDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });
    await settle();

    expect(
      groupMessageService.recalculateLastMessageAfterDelete
    ).toHaveBeenCalledWith(ROOM_ID, SYS_PIN);
  });

  it("unpinDirect does NOT touch the snapshot when nothing was retracted", async () => {
    const { orchestrator, groupMessageService, groupPinService } =
      buildOrchestrator();
    groupPinService.unpin.mockResolvedValue({ pinnedCount: 0 });

    await orchestrator.unpinDirect({
      conversationType: "GROUP",
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
    });
    await settle();

    expect(
      groupMessageService.recalculateLastMessageAfterDelete
    ).not.toHaveBeenCalled();
  });
});

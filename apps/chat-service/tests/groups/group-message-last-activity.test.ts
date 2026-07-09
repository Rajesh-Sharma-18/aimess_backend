/**
 * Unit coverage for GroupMessageService's lastActivity recalculation after a
 * delete — the shared logic the REST controller, the socket
 * ChatMessageOrchestrator.deleteDirect, and gRPC deleteMessage all reuse (no
 * duplicate implementation per entry point). Mirrors the depth of
 * `tests/community/community-delete-last-activity.test.ts` for group chat.
 */
import { GroupMessageService } from "../../src/services/group-message.service.js";

function makeService(overrides: {
  messageRepo?: Record<string, jest.Mock>;
  roomRepo?: Record<string, jest.Mock>;
}) {
  const messageRepo = {
    findPreviousVisible: jest.fn(),
    findPreviousVisibleForUser: jest.fn(),
    ...overrides.messageRepo,
  };
  const roomRepo = {
    findByRoomId: jest.fn(),
    setLastMessage: jest.fn(),
    ...overrides.roomRepo,
  };
  const service = new GroupMessageService(
    messageRepo as any,
    roomRepo as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, messageRepo, roomRepo };
}

const ROOM = "grp_room_1";
const DELETED_ID = "msg-deleted";

describe("GroupMessageService.recalculateLastMessageAfterDelete (forEveryone)", () => {
  it("deleting the LATEST message: resolves the previous visible message and updates the room snapshot", async () => {
    const prev = {
      id: "msg-prev",
      senderId: "member-1",
      senderName: "Alice",
      content: { text: "hello group" },
      messageType: "TEXT",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    };
    const { service, roomRepo } = makeService({
      messageRepo: { findPreviousVisible: jest.fn().mockResolvedValue(prev) },
      roomRepo: {
        findByRoomId: jest
          .fn()
          .mockResolvedValue({ roomId: ROOM, lastMessageId: DELETED_ID }),
      },
    });

    const recalc = await service.recalculateLastMessageAfterDelete(
      ROOM,
      DELETED_ID
    );

    expect(recalc).toMatchObject({
      prevMessageId: "msg-prev",
      hasLastMessage: true,
      senderId: "member-1",
      senderName: "Alice",
    });
    expect(roomRepo.setLastMessage).toHaveBeenCalledWith(ROOM, {
      id: "msg-prev",
      senderId: "member-1",
      senderName: "Alice",
      content: { text: "hello group" },
      messageType: "TEXT",
      createdAt: prev.createdAt,
    });
  });

  it("deleting a MIDDLE message (not the room's current last): no-op — returns null, never touches the room snapshot", async () => {
    const { service, roomRepo } = makeService({
      messageRepo: {
        findPreviousVisible: jest
          .fn()
          .mockResolvedValue({ id: "msg-current-last", createdAt: new Date() }),
      },
      roomRepo: {
        findByRoomId: jest
          .fn()
          .mockResolvedValue({
            roomId: ROOM,
            lastMessageId: "msg-current-last",
          }),
      },
    });

    const recalc = await service.recalculateLastMessageAfterDelete(
      ROOM,
      DELETED_ID
    );

    expect(recalc).toBeNull();
    expect(roomRepo.setLastMessage).not.toHaveBeenCalled();
  });

  it("EMPTY CONVERSATION after deletion: clears the room's lastMessage via the project-standard setLastMessage(roomId, null)", async () => {
    const { service, roomRepo } = makeService({
      messageRepo: { findPreviousVisible: jest.fn().mockResolvedValue(null) },
      roomRepo: {
        findByRoomId: jest
          .fn()
          .mockResolvedValue({ roomId: ROOM, lastMessageId: DELETED_ID }),
      },
    });

    const recalc = await service.recalculateLastMessageAfterDelete(
      ROOM,
      DELETED_ID
    );

    expect(recalc).toMatchObject({
      prevMessageId: null,
      hasLastMessage: false,
    });
    expect(roomRepo.setLastMessage).toHaveBeenCalledWith(ROOM, null);
  });

  it("SYSTEM MESSAGE edge case: a system-event message (e.g. 'member joined') is a valid previous-visible candidate — group system lines ARE allowed to become the preview, matching the send-path business rule (GroupSystemMessageService bumps lastMessage on post)", async () => {
    const prevSystem = {
      id: "msg-system",
      senderId: null,
      senderName: "",
      content: { text: "" },
      messageType: "SYSTEM",
      systemEvent: "MEMBER_JOINED",
      createdAt: new Date("2026-07-01T09:00:00.000Z"),
    };
    const { service, roomRepo } = makeService({
      messageRepo: {
        findPreviousVisible: jest.fn().mockResolvedValue(prevSystem),
      },
      roomRepo: {
        findByRoomId: jest
          .fn()
          .mockResolvedValue({ roomId: ROOM, lastMessageId: DELETED_ID }),
      },
    });

    const recalc = await service.recalculateLastMessageAfterDelete(
      ROOM,
      DELETED_ID
    );

    expect(recalc).toMatchObject({
      prevMessageId: "msg-system",
      messageType: "SYSTEM",
      hasLastMessage: true,
    });
    expect(roomRepo.setLastMessage).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ id: "msg-system", messageType: "SYSTEM" })
    );
  });

  it("returns null when the room no longer exists", async () => {
    const { service, roomRepo } = makeService({
      roomRepo: { findByRoomId: jest.fn().mockResolvedValue(null) },
    });

    const recalc = await service.recalculateLastMessageAfterDelete(
      ROOM,
      DELETED_ID
    );

    expect(recalc).toBeNull();
    expect(roomRepo.setLastMessage).not.toHaveBeenCalled();
  });
});

describe("GroupMessageService.recalculateLastMessageAfterDeleteForMe", () => {
  const VIEWER = "viewer-1";

  it("DELETE FOR ME on the viewer's effective last message: resolves their own previous visible message, does NOT touch the shared room snapshot", async () => {
    const deletedCreatedAt = new Date("2026-07-01T10:00:00.000Z");
    const prev = {
      id: "msg-prev-for-viewer",
      senderId: "member-2",
      senderName: "Bob",
      content: { text: "earlier" },
      messageType: "TEXT",
      createdAt: new Date(deletedCreatedAt.getTime() - 1000),
    };
    const { service, roomRepo, messageRepo } = makeService({
      messageRepo: {
        findPreviousVisibleForUser: jest.fn().mockResolvedValue(prev),
      },
      roomRepo: { findByRoomId: jest.fn().mockResolvedValue({ roomId: ROOM }) },
    });

    const recalc = await service.recalculateLastMessageAfterDeleteForMe(
      ROOM,
      deletedCreatedAt,
      VIEWER
    );

    expect(recalc).toMatchObject({
      prevMessageId: "msg-prev-for-viewer",
      hasLastMessage: true,
      wasEffectiveLast: true,
    });
    expect(messageRepo.findPreviousVisibleForUser).toHaveBeenCalledWith(
      ROOM,
      VIEWER
    );
    expect(roomRepo.setLastMessage).not.toHaveBeenCalled();
  });

  it("DELETE FOR ME on a message that was NOT the viewer's effective last: wasEffectiveLast is false (caller treats as no-op)", async () => {
    const deletedCreatedAt = new Date("2026-06-01T10:00:00.000Z");
    const { service } = makeService({
      messageRepo: {
        findPreviousVisibleForUser: jest.fn().mockResolvedValue({
          id: "newer-msg",
          senderId: "member-2",
          senderName: "Bob",
          content: { text: "newer" },
          messageType: "TEXT",
          createdAt: new Date("2026-07-01T10:00:00.000Z"),
        }),
      },
      roomRepo: { findByRoomId: jest.fn().mockResolvedValue({ roomId: ROOM }) },
    });

    const recalc = await service.recalculateLastMessageAfterDeleteForMe(
      ROOM,
      deletedCreatedAt,
      VIEWER
    );

    expect(recalc?.wasEffectiveLast).toBe(false);
  });

  it("EMPTY for the viewer after deletion: hasLastMessage:false, wasEffectiveLast:true (nothing visible remains for them)", async () => {
    const { service } = makeService({
      messageRepo: {
        findPreviousVisibleForUser: jest.fn().mockResolvedValue(null),
      },
      roomRepo: { findByRoomId: jest.fn().mockResolvedValue({ roomId: ROOM }) },
    });

    const recalc = await service.recalculateLastMessageAfterDeleteForMe(
      ROOM,
      new Date(),
      VIEWER
    );

    expect(recalc).toMatchObject({
      prevMessageId: null,
      hasLastMessage: false,
      wasEffectiveLast: true,
    });
  });

  it("returns null when the room no longer exists", async () => {
    const { service } = makeService({
      roomRepo: { findByRoomId: jest.fn().mockResolvedValue(null) },
    });

    const recalc = await service.recalculateLastMessageAfterDeleteForMe(
      ROOM,
      new Date(),
      VIEWER
    );

    expect(recalc).toBeNull();
  });
});

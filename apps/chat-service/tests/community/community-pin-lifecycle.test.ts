/**
 * Pin/unpin lifecycle — the "X pinned a message" SYSTEM line must be
 * retracted when the pin it belongs to goes away (explicit unpin OR being
 * replaced by pinning a different message), reusing the exact same
 * `deletedForAll` hard-hide + tombstone-publish mechanism as a normal message
 * delete (via `CommunitySystemMessageService.retractSystemMessage`).
 *
 * Regression coverage for: pin creates a system line, unpin removes THAT
 * line (and no other), and re-pinning creates a fresh line.
 */
import { CommunityPinService } from "../../src/services/community-pin.service.js";

const ROOM_ID = "c".repeat(24);
const MSG_ID = "m".repeat(24);
const MSG_ID_2 = "n".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const SYS_MSG_ID_1 = "s1111111111111111111111";
const SYS_MSG_ID_2 = "s2222222222222222222222";

function makeService(opts: {
  activePin?: Record<string, unknown> | null;
  message?: Record<string, unknown> | null;
  postReturnId?: jest.Mock;
  retractSystemMessage?: jest.Mock;
}) {
  const activeMember = { status: "active", isMuted: false, mutedUntil: null };

  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue(activeMember),
  } as never;

  const roomRepo = {
    findRoomById: jest
      .fn()
      .mockResolvedValue({
        id: ROOM_ID,
        status: "active",
        name: "Test Community",
      }),
    incPinnedCount: jest.fn().mockResolvedValue({ pinnedCount: 1 }),
  } as never;

  const messageRepo = {
    findById: jest.fn((messageId: string) =>
      Promise.resolve(
        opts.message ?? {
          id: messageId,
          roomId: ROOM_ID,
          messageType: "TEXT",
          deletedForAll: false,
          message: "hello",
          sentBy: USER_ID,
          senderName: "",
          senderAvatar: "",
          createdAt: new Date(),
        }
      )
    ),
  } as never;

  let currentActivePin: Record<string, unknown> | null =
    opts.activePin === undefined ? null : opts.activePin;

  const pinRepo = {
    findActivePinByRoom: jest.fn(() => Promise.resolve(currentActivePin)),
    findActivePinByMessageId: jest.fn(() => Promise.resolve(currentActivePin)),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({})
    ),
    softDeletePin: jest.fn(
      (pinId: string, unpinnedByUserId: string, unpinnedAt: Date) => {
        const pin = currentActivePin;
        currentActivePin = null;
        return Promise.resolve(
          pin ? { ...pin, unpinnedAt, unpinnedByUserId } : null
        );
      }
    ),
    createPin: jest.fn((data: Record<string, unknown>) => {
      const created = {
        id: `pin-${data.messageId}`,
        ...data,
        unpinnedAt: null,
        pinSystemMessageId: null,
      };
      currentActivePin = created;
      return Promise.resolve(created);
    }),
    setPinSystemMessageId: jest.fn((pinId: string, systemMessageId: string) => {
      if (currentActivePin && currentActivePin.id === pinId) {
        currentActivePin = {
          ...currentActivePin,
          pinSystemMessageId: systemMessageId,
        };
      }
      return Promise.resolve();
    }),
  } as never;

  const systemMessageService = {
    postReturnId:
      opts.postReturnId ?? jest.fn().mockResolvedValue(SYS_MSG_ID_1),
    retractSystemMessage:
      opts.retractSystemMessage ?? jest.fn().mockResolvedValue(undefined),
  } as never;

  const svc = new CommunityPinService(
    pinRepo,
    messageRepo,
    roomRepo,
    memberRepo,
    systemMessageService
  );

  return {
    svc,
    pinRepo,
    systemMessageService,
    getCurrentActivePin: () => currentActivePin,
  };
}

describe("Pin → system message created", () => {
  it("posts a PINNED_MESSAGE system line and stores the back-reference on the pin", async () => {
    const postReturnId = jest.fn().mockResolvedValue(SYS_MSG_ID_1);
    const { svc, pinRepo } = makeService({ postReturnId });

    const result = await svc.pin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: MOD_ID,
      communityId: ROOM_ID,
    });

    expect(postReturnId).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessageType: "PINNED_MESSAGE" })
    );
    expect(pinRepo.setPinSystemMessageId).toHaveBeenCalledWith(
      result.pin.id,
      SYS_MSG_ID_1
    );
  });
});

describe("Unpin → same system message removed", () => {
  it("retracts the pin's own system line and returns its id", async () => {
    const retractSystemMessage = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService({
      activePin: {
        id: "pin-1",
        roomId: ROOM_ID,
        communityId: ROOM_ID,
        messageId: MSG_ID,
        pinnedBy: MOD_ID,
        pinnedAt: new Date(),
        pinSystemMessageId: SYS_MSG_ID_1,
      },
      retractSystemMessage,
    });

    const result = await svc.unpin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: MOD_ID,
    });

    expect(retractSystemMessage).toHaveBeenCalledWith({
      communityId: ROOM_ID,
      messageId: SYS_MSG_ID_1,
    });
    expect(result.retractedSystemMessageId).toBe(SYS_MSG_ID_1);
  });

  it("is a no-op retraction when the pin never got a system line (e.g. best-effort post failed)", async () => {
    const retractSystemMessage = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService({
      activePin: {
        id: "pin-1",
        roomId: ROOM_ID,
        communityId: ROOM_ID,
        messageId: MSG_ID,
        pinnedBy: MOD_ID,
        pinnedAt: new Date(),
        pinSystemMessageId: null,
      },
      retractSystemMessage,
    });

    const result = await svc.unpin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: MOD_ID,
    });

    expect(retractSystemMessage).not.toHaveBeenCalled();
    expect(result.retractedSystemMessageId).toBeNull();
  });
});

describe("Other pins unaffected", () => {
  it("unpinning one room's pin never touches another pin's system message", async () => {
    const retractSystemMessage = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService({
      activePin: {
        id: "pin-room-a",
        roomId: ROOM_ID,
        communityId: ROOM_ID,
        messageId: MSG_ID,
        pinnedBy: MOD_ID,
        pinnedAt: new Date(),
        pinSystemMessageId: SYS_MSG_ID_1,
      },
      retractSystemMessage,
    });

    await svc.unpin({ roomId: ROOM_ID, messageId: MSG_ID, userId: MOD_ID });

    // Only ever called once, and only with THIS pin's own system message id —
    // a different room/pin's SYS_MSG_ID_2 is never referenced.
    expect(retractSystemMessage).toHaveBeenCalledTimes(1);
    expect(retractSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: SYS_MSG_ID_1 })
    );
    expect(retractSystemMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: SYS_MSG_ID_2 })
    );
  });
});

describe("Re-pin creates a new system message", () => {
  it("pinning a different message retracts the OLD pin's line and posts a NEW one", async () => {
    const postReturnId = jest
      .fn()
      .mockResolvedValueOnce(SYS_MSG_ID_1)
      .mockResolvedValueOnce(SYS_MSG_ID_2);
    const retractSystemMessage = jest.fn().mockResolvedValue(undefined);

    const { svc, getCurrentActivePin } = makeService({
      postReturnId,
      retractSystemMessage,
    });

    const first = await svc.pin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: MOD_ID,
      communityId: ROOM_ID,
    });
    expect(
      first.pin.pinSystemMessageId ?? getCurrentActivePin()?.pinSystemMessageId
    ).toBe(SYS_MSG_ID_1);

    const second = await svc.pin({
      roomId: ROOM_ID,
      messageId: MSG_ID_2,
      userId: MOD_ID,
      communityId: ROOM_ID,
    });

    // The old pin's system line was retracted...
    expect(retractSystemMessage).toHaveBeenCalledWith({
      communityId: ROOM_ID,
      messageId: SYS_MSG_ID_1,
    });
    // ...and a fresh line was posted for the new pin.
    expect(postReturnId).toHaveBeenCalledTimes(2);
    expect(second.replacedPin?.messageId).toBe(MSG_ID);
    expect(second.pin.messageId).toBe(MSG_ID_2);
  });
});

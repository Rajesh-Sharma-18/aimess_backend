import { PrivateRoomRepository } from "../../src/repositories/private-room.repository.js";

/**
 * The room snapshot write is a raw findAndModify, so it addresses the Mongo
 * COLLECTION (`private_rooms`), not the Prisma model. Mongo does not error on
 * an unknown collection — it returns {value: null} — so a wrong name here is
 * invisible at runtime and silently drops lastMessageAt/lastMessage/unread,
 * which is what keeps a conversation out of the inbox forever.
 */
describe("PrivateRoomRepository.updateRoomOnNewMessage", () => {
  it("targets the mapped collection and stamps lastMessageAt + unread", async () => {
    let command: Record<string, unknown> | undefined;
    const prisma = {
      $runCommandRaw: async (cmd: Record<string, unknown>) => {
        command = cmd;
        return { value: {} };
      },
    };
    const repo = new PrivateRoomRepository(
      prisma as unknown as ConstructorParameters<
        typeof PrivateRoomRepository
      >[0]
    );

    const createdAt = new Date("2026-08-07T10:00:00.000Z");
    await repo.updateRoomOnNewMessage({
      roomId: "room-1",
      message: {
        _id: "64b7f0c2e13b4a0012345678",
        content: { text: "Hello" },
        senderId: "spider-man",
        messageType: "TEXT",
        createdAt,
      },
      receiverId: "waiter-white",
    });

    expect(command?.findAndModify).toBe("private_rooms");
    expect(command?.query).toEqual({ roomId: "room-1" });
    const update = command?.update as {
      $set: Record<string, unknown>;
      $inc: Record<string, number>;
    };
    expect(update.$set.lastMessageAt).toEqual({
      $date: createdAt.toISOString(),
    });
    expect(update.$inc["unreadCountByUser.waiter-white"]).toBe(1);
  });
});

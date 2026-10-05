import { GroupRoomRepository } from "../../src/repositories/group-room.repository.js";
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
    // The room selector still keys on roomId; the `$or` alongside it is the
    // forward-only ordering guard (see last-activity-ordering.test.ts).
    expect((command?.query as { roomId: string }).roomId).toBe("room-1");
    const update = command?.update as {
      $set: Record<string, unknown>;
      $inc: Record<string, number>;
    };
    expect(update.$set.lastMessageAt).toEqual({
      $date: createdAt.toISOString(),
    });
    expect(update.$inc["unreadCountByUser.waiter-white"]).toBe(1);
  });

  /**
   * The unread paths are built by concatenation, so an unresolved recipient
   * wrote `unreadCountByUser.""` — a bucket nothing reads, while the real peer's
   * badge stayed put. The snapshot half must still land; only the unread half
   * is skipped.
   */
  it("skips the unread write when no recipient resolved", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const prisma = {
      $runCommandRaw: async (cmd: Record<string, unknown>) => {
        commands.push(cmd);
        return { value: {} };
      },
    };
    const repo = new PrivateRoomRepository(
      prisma as unknown as ConstructorParameters<
        typeof PrivateRoomRepository
      >[0]
    );

    await repo.updateRoomOnNewMessage({
      roomId: "room-1",
      message: {
        _id: "64b7f0c2e13b4a0012345678",
        content: { text: "Hello" },
        senderId: "spider-man",
        messageType: "TEXT",
        createdAt: new Date("2026-08-07T10:00:00.000Z"),
      },
      receiverId: "",
    });

    const update = commands[0]?.update as {
      $set: Record<string, unknown>;
      $inc?: Record<string, number>;
    };
    expect(update.$inc).toBeUndefined();
    expect(
      Object.keys(update.$set).some((k) => k.endsWith(".")) // `hasUnreadByUser.` & friends
    ).toBe(false);
    expect(update.$set.lastMessageId).toEqual({
      $oid: "64b7f0c2e13b4a0012345678",
    });
  });
});

// A delete rolls the snapshot BACKWARD, which made a superseded (or deleted-message) reaction overlay "newer" again on every REST read.
describe("setLastMessage rollback write: drops the reaction overlay, keeps SYSTEM params", () => {
  const prev = {
    id: "m1",
    senderId: "spider-man",
    senderName: "Spider Man",
    content: { text: "Spider Man pinned a message" },
    messageType: "SYSTEM",
    systemEvent: "MESSAGE_PINNED",
    systemData: { actorId: "spider-man" },
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
  };

  it.each([
    ["private", PrivateRoomRepository, "privateRoom"],
    ["group", GroupRoomRepository, "groupRoom"],
  ] as const)(
    "%s room: on rollback and on emptying",
    async (_kind, Repo, model) => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const repo = new Repo({ [model]: { updateMany } } as never);

      await repo.setLastMessage("room-1", prev, { expectLastMessageId: "m2" });
      await repo.setLastMessage("room-1", null, { expectLastMessageId: "m1" });

      expect(updateMany).toHaveBeenCalledTimes(2);
      for (const [{ data }] of updateMany.mock.calls) {
        expect(data.reactionActivityAt).toBeNull();
        expect(data.reactionActivityMessageId).toBeNull();
        expect(data.reactionActivityActorPreview).toBeNull();
        expect(data.reactionActivityTargetPreview).toBeNull();
      }
      // The rolled-back SYSTEM line keeps its event, so the list can still say "You pinned a message".
      const [{ data: written }] = updateMany.mock.calls[0];
      expect(written.lastMessage ?? written.lastMessagePreview).toMatchObject({
        systemEvent: "MESSAGE_PINNED",
        systemData: { actorId: "spider-man" },
      });
    }
  );
});

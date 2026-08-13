/**
 * Bug 69 — the unread badge must be recalculated when an UNREAD message is
 * deleted, and left alone when a READ one is.
 *
 * Community unread is DERIVED from `RoomMember.lastReadAt` rather than stored as
 * a counter, so after a delete the DB count is already correct — what was
 * missing was any event telling a cached list row that its badge is now one too
 * high. `resolveUnreadDeltasAfterDelete` is the decision: per member, did this
 * message actually contribute to THEIR unread? It runs on the server precisely
 * so the client never has to guess.
 *
 * This pins the whole case matrix from the ticket. The method only touches
 * `this.memberRepo`, so it is bound to a stub rather than constructing the full
 * service.
 */
import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM = "68a1b2c3d4e5f60718293a4b";
const ALICE = "user-alice";
const BOB = "user-bob";
const SENDER = "user-sender";

const SENT_AT = new Date("2026-08-13T10:00:00.000Z");
const BEFORE = new Date("2026-08-13T09:00:00.000Z");
const AFTER = new Date("2026-08-13T11:00:00.000Z");

type Member = { userId: string; lastReadAt: Date | null };

function resolverWith(members: Member[]) {
  const findActiveByRoom = jest.fn().mockResolvedValue(members);
  const stub = { memberRepo: { findActiveByRoom } };
  const resolve =
    CommunityMessageService.prototype.resolveUnreadDeltasAfterDelete.bind(
      stub as unknown as CommunityMessageService
    );
  return { resolve, findActiveByRoom };
}

/** A normal, countable, community-wide message. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    sentBy: SENDER,
    createdAt: SENT_AT,
    messageType: "TEXT",
    systemMessageType: null,
    countInUnread: null,
    visibleToUserId: null,
    deletedBy: [],
    ...overrides,
  };
}

describe("resolveUnreadDeltasAfterDelete", () => {
  it("Case A — an UNREAD message decrements that member's badge", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({ roomId: ROOM, memberIds: [ALICE], deletedMessage: message() })
    ).resolves.toEqual({ [ALICE]: -1 });
  });

  it("Case B — a message the member had ALREADY READ leaves the badge alone", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: AFTER }]);

    await expect(
      resolve({ roomId: ROOM, memberIds: [ALICE], deletedMessage: message() })
    ).resolves.toEqual({});
  });

  it("a member who has never read anything has everything unread", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: null }]);

    await expect(
      resolve({ roomId: ROOM, memberIds: [ALICE], deletedMessage: message() })
    ).resolves.toEqual({ [ALICE]: -1 });
  });

  it("Case E — delete-for-everyone adjusts each member independently", async () => {
    const { resolve } = resolverWith([
      { userId: ALICE, lastReadAt: BEFORE }, // still unread
      { userId: BOB, lastReadAt: AFTER }, // already read
      { userId: SENDER, lastReadAt: BEFORE }, // own message
    ]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE, BOB, SENDER],
        deletedMessage: message(),
      })
    ).resolves.toEqual({ [ALICE]: -1 });
  });

  it("Case F — delete-for-me touches ONLY the acting member", async () => {
    const { resolve } = resolverWith([
      { userId: ALICE, lastReadAt: BEFORE },
      { userId: BOB, lastReadAt: BEFORE },
    ]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE, BOB],
        deletedMessage: message(),
        onlyUserId: ALICE,
      })
    ).resolves.toEqual({ [ALICE]: -1 });
  });

  it("never decrements the sender for their own message", async () => {
    const { resolve } = resolverWith([{ userId: SENDER, lastReadAt: BEFORE }]);

    await expect(
      resolve({ roomId: ROOM, memberIds: [SENDER], deletedMessage: message() })
    ).resolves.toEqual({});
  });

  it("never decrements a member who had ALREADY hidden the message for themselves", async () => {
    // It was never in their derived count — decrementing would push the badge
    // BELOW the real number of unread messages.
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE],
        deletedMessage: message({ deletedBy: [ALICE] }),
      })
    ).resolves.toEqual({});
  });

  it("SYSTEM messages never counted toward unread, so deleting one changes nothing", async () => {
    const { resolve, findActiveByRoom } = resolverWith([
      { userId: ALICE, lastReadAt: BEFORE },
    ]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE],
        deletedMessage: message({ messageType: "SYSTEM" }),
      })
    ).resolves.toEqual({});
    // Short-circuits before touching the DB.
    expect(findActiveByRoom).not.toHaveBeenCalled();
  });

  it("a row carrying any systemMessageType is excluded, whatever its messageType", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE],
        deletedMessage: message({ systemMessageType: "MEMBER_JOINED" }),
      })
    ).resolves.toEqual({});
  });

  it("an explicit countInUnread:false row is excluded", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE],
        deletedMessage: message({ countInUnread: false }),
      })
    ).resolves.toEqual({});
  });

  it("a PERSONAL system row (visibleToUserId set) never inflated a badge", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE],
        deletedMessage: message({ visibleToUserId: ALICE }),
      })
    ).resolves.toEqual({});
  });

  it("ignores ids that are no longer active members of the room", async () => {
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: BEFORE }]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE, "left-the-community"],
        deletedMessage: message(),
      })
    ).resolves.toEqual({ [ALICE]: -1 });
  });

  it("skips the member fetch entirely when nobody is eligible", async () => {
    const { resolve, findActiveByRoom } = resolverWith([]);

    await expect(
      resolve({
        roomId: ROOM,
        memberIds: [ALICE, BOB],
        deletedMessage: message(),
        onlyUserId: "someone-not-in-the-list",
      })
    ).resolves.toEqual({});
    expect(findActiveByRoom).not.toHaveBeenCalled();
  });

  it("a message read at EXACTLY its own timestamp counts as read", async () => {
    // `lastReadAt < createdAt` is the unread test — equality means the pointer
    // already covers this message.
    const { resolve } = resolverWith([{ userId: ALICE, lastReadAt: SENT_AT }]);

    await expect(
      resolve({ roomId: ROOM, memberIds: [ALICE], deletedMessage: message() })
    ).resolves.toEqual({});
  });
});

import type {
  PrismaClient,
  GeneralRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import { listRowIdentity } from "../lib/list-row-identity.js";

/** A `PrismaClient` or the interactive-transaction client Prisma hands the callback in `$transaction(async (tx) => ...)`. */
type PrismaOrTx = PrismaClient | Prisma.TransactionClient;

export class GeneralRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findRoomById(roomId: string): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.findUnique({ where: { id: roomId } });
  }

  /**
   * Atomically allocate the next per-room monotonic sequence number. Mirrors
   * PrivateRoomRepository/GroupRoomRepository.allocateSequence, but keys on the
   * GeneralRoom primary id (roomId === community/general-room id). Sequences are
   * monotonic, not gapless — a rare idempotent-race retry may burn one number.
   *
   * Wrapped in `withWriteConflictRetry`: a burst of concurrent sends to one room
   * all `$inc` the SAME GeneralRoom document, so Mongo/WiredTiger raises a
   * transient write-conflict (Prisma P2034) for the losers. Without the retry
   * those sends fail with a user-visible SERVICE_ERROR when the user types fast
   * or fires several messages at once.
   */
  async allocateSequence(roomId: string): Promise<number> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.generalRoom.update({
        where: { id: roomId },
        data: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      })
    );
    return r.lastSequence;
  }

  /**
   * Atomically allocate the next per-room CHANGE revision (Telegram `pts`).
   * Identical atomic-`$inc` + write-conflict-retry pattern as `allocateSequence`,
   * but on `lastRevision` and bumped on EVERY room state change (insert, edit,
   * delete-for-all, reaction, pin/unpin, system message) — the caller stamps the
   * returned value onto the mutated message's `revision`.
   *
   * The allocation is intended to be gapless (concurrent writers serialize on the
   * same GeneralRoom doc → consecutive values). A revision CAN still be burned if
   * the message write fails after allocation (rare); the changes feed always
   * returns the room's current `roomRevision`, so a client re-baselines its
   * high-water on drain and a burned value self-heals (empty catch-up ⇒ advance).
   * ponytail: allocate-then-write, not a single multi-doc txn — burn window is a
   * rare no-op for the client; upgrade to a $transaction only if gap-strictness
   * ever needs to survive mid-write crashes.
   */
  async allocateRevision(roomId: string): Promise<number> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.generalRoom.update({
        where: { id: roomId },
        data: { lastRevision: { increment: 1 } },
        select: { lastRevision: true },
      })
    );
    return r.lastRevision;
  }

  /**
   * Allocate BOTH the per-room monotonic sequence AND the CHANGE revision in a
   * single atomic `$inc` update. Every community send bumps both counters on
   * the same GeneralRoom doc; issuing two sequential updates doubled the
   * write-conflict footprint under bursty concurrent sends and drove the
   * intermittent SERVICE_ERROR ack (each contender collided TWICE and blew
   * past the 5-retry budget). One update → one contention window → one round-
   * trip. Callers should prefer this over calling allocateSequence +
   * allocateRevision back-to-back.
   */
  async allocateSequenceAndRevision(
    roomId: string
  ): Promise<{ sequenceNumber: number; revision: number }> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.generalRoom.update({
        where: { id: roomId },
        data: {
          lastSequence: { increment: 1 },
          lastRevision: { increment: 1 },
        },
        select: { lastSequence: true, lastRevision: true },
      })
    );
    return { sequenceNumber: r.lastSequence, revision: r.lastRevision };
  }

  /** Bulk fetch rooms by id (community-chat summaries enrichment). */
  async findManyByIds(ids: string[]): Promise<GeneralRoom[]> {
    if (!ids.length) return [];
    return this.prisma.generalRoom.findMany({ where: { id: { in: ids } } });
  }

  /**
   * All room ids with their status — the diff target for the boot reconciler so
   * it can tell which communities already have a (de)activated chat room.
   */
  async listAllIdsWithStatus(): Promise<Array<{ id: string; status: string }>> {
    return this.prisma.generalRoom.findMany({
      select: { id: true, status: true },
    });
  }

  async findActiveRooms(): Promise<GeneralRoom[]> {
    return this.prisma.generalRoom.findMany({
      where: { status: "active" },
      orderBy: [{ displayOrder: "asc" }, { lastMessageAt: "desc" }],
    });
  }

  async searchRooms(query: string): Promise<GeneralRoom[]> {
    // Prisma MongoDB doesn't support $regex via the standard API.
    // Use raw query for regex-based search.
    return this.prisma.generalRoom.findMany({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query?.toLowerCase() } },
        ],
      },
      orderBy: { memberNumber: "desc" },
      take: 20,
    });
  }

  async countActiveRooms(): Promise<number> {
    return this.prisma.generalRoom.count({ where: { status: "active" } });
  }

  async countSearchResults(query: string): Promise<number> {
    return this.prisma.generalRoom.count({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
    });
  }

  async addLastestMessageToRoom(
    roomId: string,
    message: {
      _id: unknown;
      sentBy: string;
      senderName: string;
      message: string;
      messageType: string;
      createdAt: Date;
      /** Offline-first list identity (see lib/list-row-identity.ts). */
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
    }
  ): Promise<GeneralRoom | null> {
    // Same hot document as allocateSequence — bursty concurrent sends to one
    // room contend on this last-message bump too, so retry the transient
    // write-conflict rather than dropping the preview update under load.
    return withWriteConflictRetry(() =>
      this.prisma.generalRoom.update({
        where: { id: roomId },
        data: {
          lastMessageId: String(message._id),
          lastMessageAt: message.createdAt,
          lastMessage: {
            content: message.message,
            senderId: message.sentBy,
            senderName: message.senderName,
            messageType: message.messageType,
            createdAt: message.createdAt,
            ...listRowIdentity({ ...message, id: String(message._id) }),
          },
        },
      })
    );
  }

  async incMemberNumber(roomId: string, inc: number): Promise<void> {
    await this.prisma.generalRoom.update({
      where: { id: roomId },
      data: { memberNumber: { increment: inc } },
    });
  }

  async isRoomMember(_roomId: string, _userId: string): Promise<boolean> {
    // Community rooms are open -- membership is tracked in room_members
    // Return true as a default for general rooms (open communities)
    return true;
  }

  /**
   * Provision (idempotently) the chat room backing a community-service Community.
   * The room's `id` is the Community's id, so `roomId === communityId` across the
   * whole community-chat path. Driven by the `community.created` sync event.
   */
  async provisionForCommunity(
    communityId: string,
    data: {
      name: string;
      owner?: string | null;
      logo?: string | null;
      communityType?: "PUBLIC" | "PRIVATE" | null;
    }
  ): Promise<void> {
    await this.prisma.generalRoom.upsert({
      where: { id: communityId },
      create: {
        id: communityId,
        name: data.name,
        owner: data.owner ?? null,
        logo: data.logo ?? null,
        status: "active",
        communityType: data.communityType ?? null,
      },
      update: {
        // Keep room metadata in sync, and re-activate if it was soft-removed.
        name: data.name,
        logo: data.logo ?? null,
        status: "active",
        // Only overwrite the type when the caller actually knows it (avoid
        // clobbering a known type with null from a metadata-only provision).
        ...(data.communityType != null
          ? { communityType: data.communityType }
          : {}),
      },
    });
  }

  /**
   * Persist the parent community's visibility (PUBLIC/PRIVATE) on the room so the
   * read-access guard can let non-members browse PUBLIC history. Driven by the
   * `community.visibility_changed` event and the boot reconciler. Tolerates a
   * missing room (a not-yet-provisioned community) — updateMany is a no-op then.
   */
  async setCommunityType(
    communityId: string,
    communityType: "PUBLIC" | "PRIVATE"
  ): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId },
      data: { communityType },
    });
  }

  async incPinnedCount(
    roomId: string,
    inc: number,
    client: PrismaOrTx = this.prisma
  ): Promise<GeneralRoom | null> {
    return client.generalRoom.update({
      where: { id: roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Unconditionally overwrite the room's last-message snapshot. Accepts null
   * to clear (used when the deleted message was the only message in the room).
   * Unlike `addLastestMessageToRoom` (which is called on new sends), this does
   * NOT retry write-conflicts — it is a fire-and-forget preview update, not a
   * critical sequence-number allocation, so a single attempt is fine.
   */
  async setLastMessage(
    roomId: string,
    message: {
      id: string;
      sentBy: string;
      senderName: string;
      content: string;
      messageType: string;
      createdAt: Date;
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
    } | null
  ): Promise<void> {
    await this.prisma.generalRoom.update({
      where: { id: roomId },
      data: message
        ? {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            lastMessage: {
              content: message.content,
              senderId: message.sentBy,
              senderName: message.senderName,
              messageType: message.messageType,
              createdAt: message.createdAt,
              ...listRowIdentity(message),
            },
          }
        : {
            lastMessageId: null,
            lastMessageAt: null,
            lastMessage: null as unknown as Prisma.InputJsonValue,
          },
    });
  }

  /** Soft-deactivate a community's chat room (driven by `community.deleted`). */
  async deactivateForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId },
      data: { status: "inactive" },
    });
  }

  /**
   * Suspend a community's chat room (driven by `community.status.changed` with
   * status=SUSPENDED). Sets room status to "suspended" so `sendMessage` blocks
   * new messages. Members can still read history.
   */
  async suspendForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId, status: "active" },
      data: { status: "suspended" },
    });
  }

  /**
   * Unsuspend a community's chat room (driven by `community.status.changed` with
   * status=ACTIVE). Only transitions rooms that are currently "suspended" so a
   * reopen can never accidentally reactivate a hard-deleted ("inactive") room.
   */
  async unsuspendForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId, status: "suspended" },
      data: { status: "active" },
    });
  }

  async updatePinnedMessages(
    roomId: string,
    pinnedIds: string[]
  ): Promise<void> {
    await this.prisma.generalRoom.update({
      where: { id: roomId },
      data: { listPinedMessage: pinnedIds },
    });
  }
}

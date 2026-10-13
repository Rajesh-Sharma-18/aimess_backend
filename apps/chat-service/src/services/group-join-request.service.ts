import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { publishChatUserEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";
import { ChatEvents } from "@aimess/shared-types";
import type { Redis, Cluster } from "ioredis";

import { SystemEvent } from "../types/enums.js";
import { assertGroupMember } from "../lib/access-guard.js";
import { resolveMediaUrl, resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import { publishGroupEventSafe } from "../events/publish-group-member-added.js";
import { resolveDisplayName, type UserSnapshotService } from "./user-snapshot.service.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";

import type { GroupJoinRequestRepository } from "../repositories/group-join-request.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GroupJoinRequest } from "../generated/prisma/index.js";
import type { GroupMemberService } from "./group-member.service.js";

export interface GroupJoinRequestDto {
  id: string;
  roomId: string;
  userId: string;
  status: string;
  createdAt: string;
  user: { userId: string; displayName: string; username: string; avatarUrl: string };
  group: { roomId: string; name: string; avatarUrl: string };
}

export function requiresJoinApproval(room: { settings?: unknown } | null): boolean {
  return (room?.settings as { joinApproval?: unknown } | null)?.joinApproval === true;
}

export class GroupJoinRequestService {
  constructor(
    private readonly repo: GroupJoinRequestRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly redis: Redis | Cluster,
    private readonly inviteLinkRepo?: GroupInviteLinkRepository,
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository
  ) {}

  /** Idempotent: an existing PENDING row is returned as-is, with no re-notify. */
  async requestViaLink(params: {
    roomId: string;
    userId: string;
    inviteToken: string;
    invitedBy: string;
  }): Promise<GroupJoinRequestDto> {
    const existing = await this.repo.findPending(params.roomId, params.userId);
    if (existing) return (await this.toDtos([existing]))[0]!;

    let row: GroupJoinRequest;
    try {
      row = await this.repo.create(params);
    } catch (err) {
      // Partial unique index (roomId, userId | PENDING): a double tap lost the race.
      if (!isDuplicateKeyError(err)) throw err;
      const winner = await this.repo.findPending(params.roomId, params.userId);
      if (!winner) throw err;
      return (await this.toDtos([winner]))[0]!;
    }

    const [dto] = await this.toDtos([row]);
    const admins = await this.adminIds(row.roomId);
    await Promise.all(
      admins.map((id) =>
        publishChatUserEvent(this.redis, id, "group:join_request:new", {
          roomId: row.roomId,
          request: dto,
        }).catch(() => undefined)
      )
    );
    publishGroupEventSafe(ChatEvents.GROUP_JOIN_REQUESTED, {
      roomId: row.roomId,
      groupName: dto!.group.name,
      requestId: row.id,
      requesterId: row.userId,
      adminRecipientIds: admins.filter((id) => id !== row.userId),
      eventAt: new Date().toISOString(),
    });
    return dto!;
  }

  findPending(roomId: string, userId: string): Promise<GroupJoinRequest | null> {
    return this.repo.findPending(roomId, userId);
  }

  async getDto(row: GroupJoinRequest): Promise<GroupJoinRequestDto> {
    return (await this.toDtos([row]))[0]!;
  }

  async listForRoom(
    roomId: string,
    callerId: string,
    params: { cursor?: string; limit?: number }
  ): Promise<{ items: GroupJoinRequestDto[]; nextCursor: string | null; total: number }> {
    await assertGroupMember(this.memberRepo, roomId, callerId, { roles: ["ADMIN"] });
    const limit = Math.min(Math.max(params.limit || 20, 1), 50);
    const rows = await this.repo.listPendingByRoom(roomId, {
      cursor: params.cursor || undefined,
      limit,
    });
    const page = rows.slice(0, limit);
    // Self-heal: a requester who got in some other way must not linger as PENDING.
    const live: GroupJoinRequest[] = [];
    for (const row of page) {
      if (await this.memberRepo.findActiveByRoomAndUser(roomId, row.userId)) {
        await this.autoResolve(roomId, row.userId);
      } else {
        live.push(row);
      }
    }
    return {
      items: await this.toDtos(live),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      total: await this.repo.countPendingByRoom(roomId),
    };
  }

  async listMine(userId: string): Promise<{ items: GroupJoinRequestDto[] }> {
    return { items: await this.toDtos(await this.repo.listPendingByUser(userId)) };
  }

  async approve(
    requestId: string,
    callerId: string,
    memberService: GroupMemberService
  ): Promise<GroupJoinRequestDto> {
    const row = await this.loadForAdmin(requestId, callerId);
    if (await this.memberRepo.findActiveByRoomAndUser(row.roomId, row.userId)) {
      return this.settleAutoResolved(row);
    }
    const claimed = await this.repo.settle(row.id, "APPROVED", callerId);
    if (!claimed) throw new BadRequestError("CHAT_GROUP_JOIN_REQUEST_NOT_PENDING");

    try {
      await memberService.addMember(
        {
          roomId: row.roomId,
          userId: row.userId,
          invitedBy: row.invitedBy ?? callerId,
          joinedViaToken: row.inviteToken,
        },
        {
          systemEvent: SystemEvent.MEMBER_JOINED,
          actorId: row.userId,
          skipActorAuthz: true,
        }
      );
    } catch (err) {
      await this.repo.reopen(row.id);
      if (err instanceof ConflictError) return this.settleAutoResolved(row);
      throw err;
    }

    if (row.inviteToken) {
      await this.inviteLinkRepo?.incrementUsedCount(row.inviteToken).catch(() => null);
    }
    await this.afterSettle(claimed, callerId);
    return this.getDto(claimed);
  }

  async reject(requestId: string, callerId: string): Promise<GroupJoinRequestDto> {
    const row = await this.loadForAdmin(requestId, callerId);
    const settled = await this.repo.settle(row.id, "REJECTED", callerId);
    if (!settled) throw new BadRequestError("CHAT_GROUP_JOIN_REQUEST_NOT_PENDING");
    await this.afterSettle(settled, callerId);
    return this.getDto(settled);
  }

  async cancel(requestId: string, callerId: string): Promise<GroupJoinRequestDto> {
    const row = await this.repo.findById(requestId);
    // Someone else's request reads as not found — no probing other users' ids.
    if (!row || row.userId !== callerId) {
      throw new NotFoundError("CHAT_GROUP_JOIN_REQUEST_NOT_FOUND");
    }
    const settled = await this.repo.settle(row.id, "CANCELLED", callerId);
    if (!settled) throw new BadRequestError("CHAT_GROUP_JOIN_REQUEST_NOT_PENDING");
    await this.afterSettle(settled, callerId);
    return this.getDto(settled);
  }

  /** The user became a member some other way — close their PENDING request. */
  async autoResolve(roomId: string, userId: string): Promise<void> {
    const pending = await this.repo.findPending(roomId, userId);
    if (!pending) return;
    const settled = await this.repo.settle(pending.id, "AUTO_RESOLVED", null);
    if (settled) await this.afterSettle(settled, null);
  }

  private async settleAutoResolved(row: GroupJoinRequest): Promise<GroupJoinRequestDto> {
    const settled = await this.repo.settle(row.id, "AUTO_RESOLVED", null);
    if (settled) await this.afterSettle(settled, null);
    return this.getDto(settled ?? (await this.repo.findById(row.id)) ?? row);
  }

  private async loadForAdmin(requestId: string, callerId: string): Promise<GroupJoinRequest> {
    const row = await this.repo.findById(requestId);
    if (!row) throw new NotFoundError("CHAT_GROUP_JOIN_REQUEST_NOT_FOUND");
    await assertGroupMember(this.memberRepo, row.roomId, callerId, { roles: ["ADMIN"] });
    if (row.status !== "PENDING") {
      throw new BadRequestError("CHAT_GROUP_JOIN_REQUEST_NOT_PENDING");
    }
    return row;
  }

  private async afterSettle(row: GroupJoinRequest, decidedBy: string | null): Promise<void> {
    try {
      const admins = await this.adminIds(row.roomId);
      await Promise.all(
        admins.map((id) =>
          publishChatUserEvent(this.redis, id, "group:join_request:resolved", {
            roomId: row.roomId,
            requestId: row.id,
            status: row.status,
            decidedBy,
          }).catch(() => undefined)
        )
      );
      const eventAt = new Date().toISOString();
      publishGroupEventSafe(ChatEvents.GROUP_JOIN_REQUEST_RETRACTED, {
        roomId: row.roomId,
        requestId: row.id,
        requesterId: row.userId,
        adminRecipientIds: admins,
        resolution: row.status,
        eventAt,
      });
      if ((row.status === "APPROVED" || row.status === "REJECTED") && decidedBy) {
        publishGroupEventSafe(
          row.status === "APPROVED"
            ? ChatEvents.GROUP_JOIN_REQUEST_APPROVED
            : ChatEvents.GROUP_JOIN_REQUEST_REJECTED,
          {
            roomId: row.roomId,
            requestId: row.id,
            requesterId: row.userId,
            decidedBy,
            eventAt,
          }
        );
      }
      if (row.status === "REJECTED") {
        await publishChatUserEvent(this.redis, row.userId, "group:join_request:rejected", {
          roomId: row.roomId,
          requestId: row.id,
        });
      }
    } catch (err) {
      logger.warn(`group join-request fan-out failed request=${row.id}: ${String(err)}`);
    }
  }

  private async adminIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveMembers(roomId);
    return members.filter((m) => m.role === "ADMIN").map((m) => m.userId);
  }

  private async toDtos(rows: GroupJoinRequest[]): Promise<GroupJoinRequestDto[]> {
    if (!rows.length) return [];
    const roomIds = [...new Set(rows.map((r) => r.roomId))];
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [rooms, snapshots] = await Promise.all([
      Promise.all(roomIds.map((id) => this.roomRepo.findByRoomId(id))),
      this.userSnapshotService && this.cacheRepo
        ? this.userSnapshotService.getUserSnapshotsMap(userIds, this.cacheRepo)
        : Promise.resolve(new Map()),
    ]);
    const roomById = new Map(
      await Promise.all(
        rooms.filter((r) => !!r).map(async (r) => [r!.roomId, { name: r!.name, avatarUrl: await resolveMediaUrl(r!.avatar) }] as const)
      )
    );
    const avatarKeys = [...snapshots.values()]
      .map((s) => (s as Record<string, unknown>).avatar)
      .filter((a): a is string => typeof a === "string" && !!a);
    const urlMap = await resolveMediaUrlMap(avatarKeys);
    return rows.map((r) => {
      const snap = (snapshots.get(r.userId) || {}) as Record<string, unknown>;
      const group = roomById.get(r.roomId);
      return {
        id: r.id,
        roomId: r.roomId,
        userId: r.userId,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        user: {
          userId: r.userId,
          displayName: resolveDisplayName(snap),
          username: (snap.memberId as string) || "",
          avatarUrl: urlFromMap(urlMap, (snap.avatar as string) || ""),
        },
        group: { roomId: r.roomId, name: group?.name ?? "", avatarUrl: group?.avatarUrl ?? "" },
      };
    });
  }
}

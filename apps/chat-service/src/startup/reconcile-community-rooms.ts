import { logger } from "@aimess/logger";

import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import { RoomMemberRepository } from "../repositories/room-member.repository.js";
import { createCommunityReconcileClient } from "../grpc/community.client.js";
import { buildRoomMemberSyncData } from "../events/community-room-sync.consumer.js";

const PAGE_LIMIT = 100;
const MAX_PAGES = 1000; // safety backstop against a pathological cursor loop

/**
 * Boot-time reconciliation of community chat rooms. Pulls communities (+ members)
 * from community-service over gRPC and closes any provisioning gaps the
 * event-driven path may have missed (events dropped while chat-service was down,
 * communities created pre-feature, etc.):
 *
 * - active community, no room   → provision the room + sync its members
 * - deleted community, room live → deactivate the room + mark members left
 *
 * Scope is the ROOM gap (the user-facing "roomless community" problem). For
 * communities whose room already exists, steady-state member drift is left to
 * the live `community.member.synced` events (syncing every member on every boot
 * would be costly at scale); members are synced here only for rooms this run
 * actually provisions, so a freshly-created room is never empty.
 *
 * Fully best-effort: never throws, never blocks startup. Logged counts make the
 * coverage explicit (no silent truncation).
 */
export async function reconcileCommunityRooms(): Promise<void> {
  if (!env.COMMUNITY_ROOM_RECONCILE_ENABLED) {
    logger.info(
      "Community room reconciler disabled (COMMUNITY_ROOM_RECONCILE_ENABLED=false)"
    );
    return;
  }

  const roomRepo = new GeneralRoomRepository(prisma);
  const memberRepo = new RoomMemberRepository(prisma);

  try {
    const client = createCommunityReconcileClient();

    // Diff target: existing room ids → status (room id === community id).
    const existing = await roomRepo.listAllIdsWithStatus();
    const roomStatusById = new Map(existing.map((r) => [r.id, r.status]));

    let afterId = "";
    let pages = 0;
    let scanned = 0;
    let provisioned = 0;
    let deactivated = 0;
    let membersSynced = 0;

    for (;;) {
      const res = await client.listCommunities({
        afterId: afterId || undefined,
        limit: PAGE_LIMIT,
      });

      for (const c of res.communities) {
        scanned++;
        const roomStatus = roomStatusById.get(c.id);

        if (c.deleted) {
          // Deactivate only if a live room still exists.
          if (roomStatus && roomStatus !== "inactive") {
            await roomRepo.deactivateForCommunity(c.id);
            await memberRepo.markAllLeft(c.id);
            deactivated++;
          }
          continue;
        }

        // Active community with no room → provision + seed members.
        if (!roomStatus) {
          await roomRepo.provisionForCommunity(c.id, {
            name: c.name,
            owner: c.adminId || null,
            logo: c.avatarUrl || null,
          });
          provisioned++;
          for (const m of c.members) {
            const data = buildRoomMemberSyncData(m.status, m.role);
            if (!data) continue;
            await memberRepo.upsert(c.id, m.userId, data);
            membersSynced++;
          }
        }
      }

      pages++;
      if (!res.hasMore || !res.nextAfterId || pages >= MAX_PAGES) {
        if (pages >= MAX_PAGES && res.hasMore) {
          logger.warn(
            `Community room reconciler hit MAX_PAGES (${MAX_PAGES}); stopping early — some communities may not have been scanned`
          );
        }
        break;
      }
      afterId = res.nextAfterId;
    }

    logger.info(
      `Community room reconciler: scanned=${scanned} provisioned=${provisioned} deactivated=${deactivated} membersSynced=${membersSynced}`
    );
  } catch (err) {
    // Best-effort: a missing/slow community-service must not break chat-service boot.
    logger.warn(
      "Community room reconciler skipped (community-service gRPC unavailable or errored)",
      err
    );
  }
}

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
 * - active community, no room    → provision the room + sync its members
 * - deleted community, room live → deactivate the room + mark members left
 * - room live, NO community at all → deactivate the room + mark members left
 *
 * That last case is not the same as the second. `c.deleted` only covers a
 * community community-service still LISTS (soft-deleted, `deletedAt` set). A
 * community whose row is gone entirely — a hard delete, a dropped collection, a
 * restore from an older snapshot — never appears in the scan, so nothing here
 * ever looked at it and its chat room stayed `active` forever. Members kept an
 * `active` RoomMember row, which is what the Community nav badge sums over, so
 * its unread counted toward the badge while `/communities/mine` (correctly)
 * omitted the row: a badge the user cannot clear, because there is no
 * conversation left to open.
 *
 * Reconciling that direction requires having seen the WHOLE community list —
 * a truncated or failed scan would otherwise deactivate live rooms it simply
 * had not reached yet — so it is gated on the scan completing.
 *
 * Scope is the ROOM gap (the user-facing "roomless community" problem), plus
 * one member-level repair in the same direction: a chat RoomMember row whose
 * community membership no longer exists at all. Nothing evicts those — the
 * live `community.member.synced` event only fires for memberships community-
 * service still has — so the row stays `active` forever and its unread keeps
 * feeding the Community nav badge while `/communities/mine` (correctly) never
 * lists the community: a badge the user has no row to open and clear. The
 * member list is already in the scan response, so the diff costs one
 * projection read per existing room and writes only when a row is genuinely
 * stale. Members are still fully SYNCED only for rooms this run provisions
 * (re-syncing every member on every boot would be costly at scale).
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
    let orphaned = 0;
    let membersSynced = 0;
    let memberDrift = 0;
    // Every community id the scan actually saw. Only meaningful as "the complete
    // set" when the loop below finishes because the server said there was no
    // more — see `scanComplete`.
    const seenCommunityIds = new Set<string>();
    let scanComplete = false;

    for (;;) {
      const res = await client.listCommunities({
        afterId: afterId || undefined,
        limit: PAGE_LIMIT,
      });

      for (const c of res.communities) {
        scanned++;
        seenCommunityIds.add(c.id);
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

        const communityType =
          c.communityType === "PUBLIC" || c.communityType === "PRIVATE"
            ? c.communityType
            : null;

        // Active community with no room → provision (with type) + seed members.
        if (!roomStatus) {
          await roomRepo.provisionForCommunity(c.id, {
            name: c.name,
            owner: c.adminId || null,
            logo: c.avatarUrl || null,
            communityType,
          });
          provisioned++;
          for (const m of c.members) {
            const data = buildRoomMemberSyncData(m.status, m.role);
            if (!data) continue;
            await memberRepo.upsert(c.id, m.userId, data);
            membersSynced++;
          }
        } else {
          if (communityType) {
            // Room already exists — backfill / refresh its persisted visibility so
            // existing PUBLIC communities (created before this field) become
            // browsable by non-members. Authoritative source: the community row.
            await roomRepo.setCommunityType(c.id, communityType);
          }
          // Evict mirror rows whose community membership is gone entirely.
          // Only rows ABSENT from the community list are touched — a member
          // community-service still knows about keeps whatever status the live
          // sync gave it, so LEFT/PENDING mapping stays that path's business.
          const known = new Set(c.members.map((m) => m.userId));
          const mirrored = await memberRepo.findLiveMemberUserIds(c.id);
          const stale = mirrored.filter((userId) => !known.has(userId));
          if (stale.length) {
            memberDrift += await memberRepo.markLeftForUsers(c.id, stale);
          }
        }
      }

      pages++;
      if (!res.hasMore || !res.nextAfterId || pages >= MAX_PAGES) {
        if (res.hasMore) {
          // Truncated: either the page backstop tripped, or the server claimed
          // more pages but handed back no cursor to reach them. Both leave
          // `seenCommunityIds` incomplete — keyed on `hasMore` alone, because
          // "why we stopped" does not change that.
          logger.warn(
            pages >= MAX_PAGES
              ? `Community room reconciler hit MAX_PAGES (${MAX_PAGES}); stopping early — some communities were not scanned`
              : "Community room reconciler stopped early — server reported more communities but returned no cursor"
          );
        } else {
          // Nothing after this page, so `seenCommunityIds` is the full community
          // list and a live room missing from it has no community behind it.
          scanComplete = true;
        }
        break;
      }
      afterId = res.nextAfterId;
    }

    // Rooms with no community behind them at all. Deliberately skipped when the
    // scan was truncated: a partial list would make every unscanned community's
    // room look orphaned and deactivate live chats.
    if (scanComplete) {
      for (const [roomId, status] of roomStatusById) {
        if (status === "inactive" || seenCommunityIds.has(roomId)) continue;
        await roomRepo.deactivateForCommunity(roomId);
        await memberRepo.markAllLeft(roomId);
        orphaned++;
      }
      if (orphaned > 0) {
        logger.warn(
          `Community room reconciler deactivated ${orphaned} orphaned room(s) with no community record`
        );
      }
    }

    logger.info(
      `Community room reconciler: scanned=${scanned} provisioned=${provisioned} deactivated=${deactivated} orphaned=${orphaned} membersSynced=${membersSynced} memberDrift=${memberDrift} scanComplete=${scanComplete}`
    );
  } catch (err) {
    // Best-effort: a missing/slow community-service must not break chat-service boot.
    logger.warn(
      "Community room reconciler skipped (community-service gRPC unavailable or errored)",
      err
    );
  }
}

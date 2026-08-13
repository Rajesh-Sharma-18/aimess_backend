import { t } from "@aimess/constants";

import type { Notification } from "../generated/prisma/index.js";

import { categorize, LOGIN_DETECTED_TYPE } from "./notification-category.js";
import {
  resolveNotificationFriendship,
  type NotificationFriendshipDTO,
} from "./notification-friendship.enricher.js";

/**
 * Notification response DTO shared by REST + gRPC list paths.
 *
 * Avatars: `actor.avatar` and `community.avatar` are read directly from
 * fields the producer already writes into `payload.data` (see the
 * `actorSnapshot` / `communityAvatarUrl` fields set in every
 * `notifications-service` consumer). No extra media round-trip — same
 * values the producer chose, just surfaced onto the response instead of
 * buried inside the raw payload blob.
 */
export interface NotificationDTO {
  id: string;
  type: string;
  category: "FRIENDS" | "COMMUNITIES" | "MENTIONS" | "SYSTEM";
  /** Null when the body already carries the subject — the client renders no heading. */
  title: string | null;
  body: string;
  isRead: boolean;
  createdAt: Date;
  /** Last-mutation timestamp; the delta-sync cursor and the LWW tiebreaker. */
  updatedAt: Date;
  /** Monotonic revision — clients drop any frame older than what they hold. */
  version: number;
  /** Stable identity of the underlying entity/action. */
  groupKey: string | null;
  /** True for tombstones returned by delta sync so clients can drop the row. */
  isDeleted: boolean;
  /** Terminal outcome line for a resolved action ("You are now friends!"). */
  resolution?: string;
  resolutionTone?: string;
  /** Action the viewer already took on this row ("TERMINATED" | "TRUSTED"). */
  actionTaken?: string;
  /**
   * Login Detected rows only: the server-owned deadline after which an
   * un-actioned alert is auto-approved ("It's Me"). Clients render the
   * countdown from THIS value — never from a locally started timer — so a
   * refresh at 10:45 on an 11:00 deadline still shows 15 minutes, not a fresh
   * hour. Absent once resolved is irrelevant: `actionTaken` is the authority
   * on whether the buttons still apply.
   */
  expiresAt?: Date;
  /** Kept for backward compatibility with clients that dug into it. */
  payload: Record<string, unknown>;
  actor?: {
    id: string;
    displayName: string;
    avatar: { url: string } | null;
  };
  community?: {
    id: string;
    name: string;
    handle?: string;
    avatar: { url: string } | null;
  };
  navigation?: unknown;
  referenceId?: string;
  friendship?: NotificationFriendshipDTO;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function nonEmpty(s: unknown): string | undefined {
  return typeof s === "string" && s.length > 0 ? s : undefined;
}

/**
 * The two status lines older builds wrote OVER a login alert's description.
 * Every writer persisted them in English — auth-service hard-codes them and the
 * web client deliberately sends the English string — so an exact match is a
 * detector, not a locale guess.
 */
const CLOBBERED_LOGIN_BODIES = new Set([
  "This was you.",
  "Session terminated.",
]);

/**
 * A login alert's status lives in `data.actionTaken` alone; its body is the
 * "New login detected on …" description. Rows resolved before that split have
 * the status sitting in the body too, so the client printed it twice (once as
 * the body, once as the resolved line). Rebuild the description from the same
 * `data` the producer built it from, so rows already in the database read the
 * same as new ones.
 *
 * ponytail: rebuilt in English — the clobbered text it replaces is English as
 * well, and this serializer has no viewer locale. Thread `req.locale` through
 * if a localized repair ever matters.
 */
function repairLoginBody(data: Record<string, string>): string {
  const device = data.browser
    ? t("NOTIF_AUTH_ON_BROWSER", "en", { browser: data.browser.toLowerCase() })
    : t("NOTIF_AUTH_NEW_DEVICE", "en");
  return data.location
    ? t("NOTIF_AUTH_NEW_LOGIN_LOCATION", "en", {
        device,
        location: data.location,
      })
    : t("NOTIF_AUTH_NEW_LOGIN", "en", { device });
}

/**
 * Freshly-resolved actor/community avatars, keyed by id, built once per page
 * by `resolveAvatarRefresh` (notification.service.ts) and threaded through to
 * every row. Takes priority over anything stored in `payload.data` — the
 * stored value is a presigned URL snapshot from publish time and may have
 * expired by the time the row is read.
 */
export interface AvatarRefreshMaps {
  actorById: Map<string, { displayName: string; avatarUrl: string }>;
  communityById: Map<string, { name: string; avatarUrl: string }>;
}

const EMPTY_REFRESH: AvatarRefreshMaps = {
  actorById: new Map(),
  communityById: new Map(),
};

/**
 * One-shot Notification row → response DTO. Reuses the existing
 * `resolveNotificationFriendship` enricher (friend actionability) — no new
 * gRPC calls beyond the batched avatar refresh already done by the caller.
 * Pass a viewerId; friendship enrichment is viewer-relative.
 */
export async function serializeNotification(
  row: Notification,
  viewerId: string,
  refresh: AvatarRefreshMaps = EMPTY_REFRESH
): Promise<NotificationDTO> {
  const payloadObj = (row.payload ?? {}) as {
    title?: string;
    body?: string;
    data?: Record<string, string>;
  };
  const data = payloadObj.data ?? {};
  const entity = (row.entity ?? {}) as { id?: string };

  const navigation = parseJson(data.navigation);
  const actorSnapshot = parseJson(data.actorSnapshot) as
    | { userId?: string; displayName?: string; avatarUrl?: string }
    | undefined;

  const actorId = row.actorId || actorSnapshot?.userId || "";
  const freshActor = actorId ? refresh.actorById.get(actorId) : undefined;
  const actorAvatarUrl = nonEmpty(
    freshActor?.avatarUrl ??
      actorSnapshot?.avatarUrl ??
      data.requesterAvatarUrl ??
      data.actorAvatarUrl
  );
  const actorDisplayName =
    freshActor?.displayName ||
    actorSnapshot?.displayName ||
    data.requesterDisplayName ||
    data.actorDisplayName ||
    "";
  const actor = actorId
    ? {
        id: actorId,
        displayName: actorDisplayName,
        avatar: actorAvatarUrl ? { url: actorAvatarUrl } : null,
      }
    : undefined;

  const communityId = nonEmpty(data.communityId);
  const freshCommunity = communityId
    ? refresh.communityById.get(communityId)
    : undefined;
  const community = communityId
    ? {
        id: communityId,
        name: freshCommunity?.name || data.communityName || "",
        handle: nonEmpty(data.communityHandle),
        avatar: nonEmpty(freshCommunity?.avatarUrl ?? data.communityAvatarUrl)
          ? {
              url: (freshCommunity?.avatarUrl ??
                data.communityAvatarUrl) as string,
            }
          : null,
      }
    : undefined;

  const friendship = await resolveNotificationFriendship(
    viewerId,
    row.type,
    data.friendshipId
  );

  const storedBody = payloadObj.body ?? "";
  const body =
    row.type === LOGIN_DETECTED_TYPE && CLOBBERED_LOGIN_BODIES.has(storedBody)
      ? repairLoginBody(data)
      : storedBody;
  const rawTitle = nonEmpty(data.inboxTitle) ?? nonEmpty(payloadObj.title);
  const title =
    data.suppressTitle === "true" ||
    !rawTitle ||
    (body.length > 0 && body.includes(rawTitle))
      ? null
      : rawTitle;

  return {
    id: row.id,
    type: row.type,
    category: categorize(row.type),
    title,
    body,
    isRead: row.isRead,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version ?? 1,
    groupKey: row.groupKey ?? null,
    isDeleted: row.isDeleted,
    ...(nonEmpty(data.resolution) ? { resolution: data.resolution } : {}),
    ...(nonEmpty(data.resolutionTone)
      ? { resolutionTone: data.resolutionTone }
      : {}),
    ...(nonEmpty(data.actionTaken) ? { actionTaken: data.actionTaken } : {}),
    ...(row.loginExpiresAt ? { expiresAt: row.loginExpiresAt } : {}),
    payload: payloadObj as Record<string, unknown>,
    ...(actor ? { actor } : {}),
    ...(community ? { community } : {}),
    ...(navigation !== undefined ? { navigation } : {}),
    ...(entity.id ? { referenceId: entity.id } : {}),
    ...(friendship ? { friendship } : {}),
  };
}

/**
 * Resource-driven download authorization.
 *
 * When an object is in the media registry, authorization is driven by its
 * resource type's policy (see @aimess/constants RESOURCE_ACCESS_POLICY):
 *   - PUBLIC                   → anyone authenticated (avatars/community branding)
 *   - OWNER                    → only the uploader
 *   - chat participant/member  → verified against chat-service membership over gRPC
 *
 * When there is NO registry row (objects uploaded before the registry, not yet
 * backfilled), it falls back to the legacy prefix/owner checks so existing files
 * keep working. Throws ForbiddenError / BadRequestError on denial.
 */
import { ForbiddenError, BadRequestError } from "@aimess/errors";
import {
  RESOURCE_ACCESS_POLICY,
  type MediaAccessPolicy,
  type MediaResourceType,
} from "@aimess/constants";
import { assertObjectKeyOwnedBy } from "@aimess/storage";
import { logger } from "@aimess/logger";

import { mediaFileRepository } from "../repositories/media-file.repository.js";
import {
  getChatAccessClient,
  type MediaAccessScope,
} from "../grpc/clients/chat-access.client.js";
import { UPLOAD_CATEGORIES, type MediaCategoryKey } from "../config/uploads.js";

const POLICY_SCOPE: Partial<Record<MediaAccessPolicy, MediaAccessScope>> = {
  PRIVATE_CHAT_PARTICIPANT: "PRIVATE_CHAT",
  GROUP_MEMBER: "GROUP_CHAT",
  COMMUNITY_MEMBER: "COMMUNITY_CHAT",
};

/**
 * Upload category → the chat-service membership scope that owns it. Only the
 * three chat-attachment categories are membership-scoped; avatars and covers are
 * PUBLIC and have no resource to belong to.
 */
const CATEGORY_SCOPE: Partial<Record<MediaCategoryKey, MediaAccessScope>> = {
  CHAT_ATTACHMENT: "PRIVATE_CHAT",
  GROUP_CHAT_ATTACHMENT: "GROUP_CHAT",
  COMMUNITY_CHAT_ATTACHMENT: "COMMUNITY_CHAT",
};

/**
 * UPLOAD-side authorization: the caller must belong to the resource they claim
 * to be uploading into.
 *
 * `resourceId` was previously taken on trust and written straight to the
 * registry, so a user could mint an upload URL against any community or group id
 * they could name and file the object under it. That is both a write into
 * someone else's storage scope and a download-authz problem later — the registry
 * row is exactly what the download guard reads back.
 *
 * No-op for the non-chat categories (nothing to be a member of).
 *
 * @throws ForbiddenError `CHAT_MEDIA_FORBIDDEN` when the caller isn't in it.
 */
export async function assertUploadResourceAccess(params: {
  category: MediaCategoryKey;
  resourceId?: string | null;
  requesterId: string;
}): Promise<void> {
  const scope = CATEGORY_SCOPE[params.category];
  if (!scope) return;
  // The validator requires resourceId for these categories; belt-and-braces for
  // any internal caller that bypasses it.
  if (!params.resourceId) throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");

  const allowed = await getChatAccessClient().checkMediaAccess({
    userId: params.requesterId,
    scope,
    resourceId: params.resourceId,
  });
  if (!allowed) throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
}

export interface AuthorizeMediaAccessParams {
  objectKey: string;
  category: MediaCategoryKey;
  requesterId: string;
}

export async function authorizeMediaAccess(
  params: AuthorizeMediaAccessParams
): Promise<void> {
  const { objectKey, category, requesterId } = params;

  let record = null;
  try {
    record = await mediaFileRepository.findByObjectKey(objectKey);
  } catch (err) {
    logger.warn(
      "download authz: registry lookup failed — falling back to legacy checks",
      { objectKey, error: err instanceof Error ? err.message : String(err) }
    );
  }

  // No registry row → legacy behavior (pre-backfill objects).
  if (!record) {
    legacyAuthz(objectKey, category, requesterId);
    return;
  }

  const policy: MediaAccessPolicy =
    RESOURCE_ACCESS_POLICY[record.resourceType as MediaResourceType] ?? "OWNER";

  if (policy === "PUBLIC") return;

  if (policy === "OWNER") {
    if (record.ownerId !== requesterId) {
      throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    }
    return;
  }

  const scope = POLICY_SCOPE[policy];
  if (scope) {
    // The uploader can always fetch their own object without a membership round-trip.
    if (record.ownerId === requesterId) return;
    if (!record.resourceId) {
      // resourceId was never recorded, so there is nothing to check membership
      // against. Falls through to the uploader-only check — see legacyAuthz.
      // `resourceId` is now required at upload time for these categories, so
      // this branch only covers rows written before that.
      legacyAuthz(objectKey, category, requesterId);
      return;
    }
    const allowed = await getChatAccessClient().checkMediaAccess({
      userId: requesterId,
      scope,
      resourceId: record.resourceId,
    });
    if (!allowed) throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    return;
  }

  // ADMIN or any unrecognized policy → fail closed (admin path not wired yet).
  throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
}

/**
 * Fallback for objects membership can't be proven for: no registry row at all
 * (uploaded before the registry existed), or a row whose `resourceId` was never
 * recorded. Reached only after the registry paths above have been exhausted.
 *
 * The object key is `{prefix}/{ownerId}/{fileId}.{ext}` — it carries the
 * UPLOADER's id and nothing about the room, group or community, so there is no
 * way to recover the resource and ask chat-service about membership. The only
 * relationship provable from the key alone is "you uploaded this", so that is
 * the only one accepted.
 *
 * COMMUNITY_CHAT_ATTACHMENT and GROUP_CHAT_ATTACHMENT used to check only that
 * the key started with the category prefix — a condition every key in the
 * category satisfies — so any authenticated caller who learned or guessed a key
 * got a presigned URL for a private community's or group's attachment.
 *
 * MIGRATION: this makes un-backfilled community/group attachments downloadable
 * by their uploader only. Backfill `MediaFile.resourceId` from the chat message
 * that carries each `objectKey` to restore access for the other members —
 * `resourceId` is now required at upload time, so only pre-existing objects are
 * affected and the set does not grow.
 */
function legacyAuthz(
  objectKey: string,
  category: MediaCategoryKey,
  requesterId: string
): void {
  const def = UPLOAD_CATEGORIES[category];
  if (!def) return;

  // Every category whose policy is NOT PUBLIC must fall back to the strictest
  // relationship the key alone can prove: "you uploaded this".
  //
  // GROUP_AVATAR used to fall off the end of this function into the
  // "avatars/covers are public" tail, even though its policy is GROUP_MEMBER
  // (packages/constants media/classification.ts). Any authenticated user could
  // fetch a private group's avatar whenever the registry row was missing — which
  // is not only "legacy objects", since registration was best-effort and a Mongo
  // blip produced the same state permanently.
  const NON_PUBLIC_FALLBACK: ReadonlySet<MediaCategoryKey> = new Set([
    "CHAT_ATTACHMENT",
    "COMMUNITY_CHAT_ATTACHMENT",
    "GROUP_CHAT_ATTACHMENT",
    "GROUP_AVATAR",
  ]);

  if (NON_PUBLIC_FALLBACK.has(category)) {
    if (!objectKey.startsWith(def.keyPrefix + "/")) {
      throw new BadRequestError("MEDIA_INVALID_OBJECT_KEY");
    }
    if (!assertObjectKeyOwnedBy(objectKey, def.keyPrefix, requesterId)) {
      logger.warn(
        "download authz: denied unprovable non-public object (no resourceId to check membership against)",
        { objectKey, category, requesterId }
      );
      throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    }
  }
  // USER_AVATAR / COMMUNITY_AVATAR / COMMUNITY_COVER: policy is PUBLIC — no check.
}

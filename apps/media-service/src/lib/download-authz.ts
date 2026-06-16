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
      // No bound resource to check membership against → fail closed.
      throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
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

/** Legacy (pre-registry) checks: preserve prior behavior for un-backfilled keys. */
function legacyAuthz(
  objectKey: string,
  category: MediaCategoryKey,
  requesterId: string
): void {
  const def = UPLOAD_CATEGORIES[category];
  if (!def) return;
  if (category === "CHAT_ATTACHMENT") {
    if (!assertObjectKeyOwnedBy(objectKey, def.keyPrefix, requesterId)) {
      throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    }
  } else if (
    category === "COMMUNITY_CHAT_ATTACHMENT" ||
    category === "GROUP_CHAT_ATTACHMENT"
  ) {
    if (!objectKey.startsWith(def.keyPrefix + "/")) {
      throw new BadRequestError("MEDIA_INVALID_OBJECT_KEY");
    }
  }
  // Avatars / covers: public — no check.
}

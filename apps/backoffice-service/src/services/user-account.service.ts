import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";
import { AdminUserEvents } from "@aimess/shared-types";
import { assertObjectKeyOwnedBy } from "@aimess/storage";

import type {
  UpdateUserAccountInput,
  UserAvatarUploadUrlInput,
} from "../api/validators/user-account.validator.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import { authClient } from "../grpc/auth.client.js";
import { getMediaConfirmClient } from "../grpc/media.client.js";
import { userClient, type AdminEditableProfile } from "../grpc/user.client.js";
import { publishAdminUserNotifySafe } from "../messaging/publish-admin-user-notify.js";
import type { RequestAdmin } from "../types/index.js";
import { auditService } from "./audit.service.js";
import { announceUserDirectoryChange } from "./user-management.service.js";

type RequestCtx = { ip: string; userAgent: string | null };

type SocialProvider = "GOOGLE" | "APPLE";

type FieldChange = { before: string | null; after: string | null };

export type UserLinkedAccount = {
  provider: SocialProvider;
  email: string | null;
  linkedAt: number;
};

export type UserAccount = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  linkedAccounts: UserLinkedAccount[];
};

const PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "username",
  "bio",
  "dateOfBirth",
  "gender",
] as const satisfies readonly (keyof AdminEditableProfile)[];

const DIRECTORY_FIELDS = [
  "email",
  "username",
  "firstName",
  "lastName",
  "avatar",
];

const ADMIN_ERROR_KEYS: Record<string, string> = {
  AUTH_LAST_SIGN_IN_METHOD: "ADMIN_USER_LAST_SIGN_IN_METHOD",
  ACCOUNT_BANNED: "ADMIN_USER_ACCOUNT_NOT_ACTIVE",
  AUTH_ACCOUNT_NOT_ACTIVE: "ADMIN_USER_ACCOUNT_NOT_ACTIVE",
  AUTH_ACCOUNT_DELETED: "ADMIN_USER_ACCOUNT_NOT_ACTIVE",
};

const ACCOUNT_UPDATED_FALLBACK_COPY = {
  title: "Account updated",
  body: "An administrator updated your account details",
};

function toClientError(errorCode: string): Error {
  if (
    !errorCode ||
    errorCode === "USER_NOT_FOUND" ||
    errorCode === "USER_PROFILE_NOT_FOUND"
  ) {
    return new NotFoundError("USER_NOT_FOUND");
  }
  if (
    errorCode === "AUTH_EMAIL_EXISTS" ||
    errorCode === "USER_USERNAME_TAKEN"
  ) {
    return new ConflictError(errorCode);
  }
  return new BadRequestError(ADMIN_ERROR_KEYS[errorCode] ?? errorCode);
}

function orNull(value: string): string | null {
  return value === "" ? null : value;
}

// The acting admin stays in the audit log only; apps read "Administrator".
function notifyAccountUpdated(userId: string): void {
  publishAdminUserNotifySafe({
    userId,
    type: AdminUserEvents.USER_ACCOUNT_UPDATED,
    ...ACCOUNT_UPDATED_FALLBACK_COPY,
  });
}

// ponytail: short in-request wait for the async AV scan; the gateway proxy
// times out at 30s and confirm alone may take up to 20s. Move to client-side
// scan-status polling if real scans routinely outlast this.
const AVATAR_SCAN_POLLS = 8;
const AVATAR_SCAN_POLL_MS = 1_000;

/**
 * Run media-service's pipeline over an admin-uploaded avatar before user-service
 * persists it (user-service refuses anything not CLEAN/SKIPPED). Skips confirm
 * when a previous attempt already cleared the object.
 */
async function assertAvatarVerified(
  userId: string,
  objectKey: string
): Promise<void> {
  if (!assertObjectKeyOwnedBy(objectKey, "avatars", userId)) {
    throw new BadRequestError("INVALID_AVATAR_OBJECT_KEY");
  }

  const media = getMediaConfirmClient();
  let verdict;
  try {
    if (await media.isDownloadable(objectKey)) return;
    verdict = await media.confirmUpload(objectKey, userId, "USER_AVATAR");
    for (
      let poll = 0;
      !verdict.downloadable &&
      verdict.scanStatus === "PENDING" &&
      poll < AVATAR_SCAN_POLLS;
      poll++
    ) {
      await new Promise((resolve) => setTimeout(resolve, AVATAR_SCAN_POLL_MS));
      if (await media.isDownloadable(objectKey)) return;
    }
  } catch (err) {
    logger.warn("user avatar: media-service unreachable — refusing to save", {
      userId,
      objectKey,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
  }

  if (verdict.downloadable) return;
  throw new BadRequestError(
    verdict.scanStatus === "INFECTED" || verdict.scanStatus === "QUARANTINED"
      ? "MEDIA_MALWARE_DETECTED"
      : verdict.scanStatus === "REJECTED"
        ? "MEDIA_SECURITY_VALIDATION_FAILED"
        : "MEDIA_NOT_VERIFIED"
  );
}

async function loadEditableProfile(
  userId: string
): Promise<AdminEditableProfile> {
  const res = await userClient.adminGetEditableProfile(userId);
  if (!res.ok || !res.profile) {
    throw toClientError(res.errorCode);
  }
  return res.profile;
}

export const userAccountService = {
  async getAccount(userId: string): Promise<UserAccount> {
    const [identity, profile] = await Promise.all([
      authClient.adminGetUserIdentity(userId),
      loadEditableProfile(userId),
    ]);
    if (!identity.ok) {
      throw toClientError(identity.errorCode);
    }

    return {
      userId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      bio: orNull(profile.bio),
      dateOfBirth: orNull(profile.dateOfBirth),
      gender: orNull(profile.gender),
      email: orNull(identity.email),
      emailVerified: identity.emailVerified,
      hasPassword: identity.hasPassword,
      linkedAccounts: (identity.providers ?? []).map((link) => ({
        provider: link.provider,
        email: orNull(link.providerEmail),
        linkedAt: Date.parse(link.linkedAt),
      })),
    };
  },

  async updateAccount(
    userId: string,
    input: UpdateUserAccountInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserAccount> {
    const profilePatch: Record<string, unknown> = Object.fromEntries(
      PROFILE_FIELDS.filter((field) => input[field] !== undefined).map(
        (field) => [field, input[field]]
      )
    );
    if (input.avatarObjectKey !== undefined) {
      // Verified before any write so a rejected image fails the whole save.
      if (input.avatarObjectKey !== null) {
        await assertAvatarVerified(userId, input.avatarObjectKey);
      }
      profilePatch.avatarObjectKey = input.avatarObjectKey;
    }
    const changes: Record<string, FieldChange> = {};

    try {
      if (input.email !== undefined) {
        const res = await authClient.adminSetUserEmail(userId, input.email);
        if (!res.ok) {
          throw toClientError(res.errorCode);
        }
        if (res.changed) {
          changes.email = {
            before: orNull(res.previousEmail),
            after: res.email,
          };
        }
      }

      if (Object.keys(profilePatch).length > 0) {
        const before = await loadEditableProfile(userId);
        const res = await userClient.adminUpdateProfile(userId, profilePatch);
        if (!res.ok || !res.profile) {
          throw toClientError(res.errorCode);
        }
        const after = res.profile;
        for (const field of res.changedFields ?? []) {
          if ((PROFILE_FIELDS as readonly string[]).includes(field)) {
            const key = field as (typeof PROFILE_FIELDS)[number];
            changes[key] = {
              before: orNull(before[key]),
              after: orNull(after[key]),
            };
          } else if (field === "avatarUrl") {
            changes.avatar = {
              before: orNull(before.avatarUrl),
              after: orNull(after.avatarUrl),
            };
          }
        }
      }
    } finally {
      if (Object.keys(changes).length > 0) {
        await auditService.record({
          actorId: actor.id,
          action: AUDIT_ACTIONS.USER_UPDATED_BY_ADMIN,
          targetType: "user",
          targetId: userId,
          before: Object.fromEntries(
            Object.entries(changes).map(([field, c]) => [field, c.before])
          ),
          after: Object.fromEntries(
            Object.entries(changes).map(([field, c]) => [field, c.after])
          ),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        notifyAccountUpdated(userId);
        if (DIRECTORY_FIELDS.some((field) => field in changes)) {
          announceUserDirectoryChange();
        }
      }
    }

    return userAccountService.getAccount(userId);
  },

  /** Presigned PUT for a new avatar, filed under the target user. */
  async createAvatarUploadUrl(
    userId: string,
    input: UserAvatarUploadUrlInput
  ): Promise<{
    uploadUrl: string;
    objectKey: string;
    expiresIn: number;
    headers: Record<string, string>;
  }> {
    // 404s a deleted/unknown user before minting anything.
    await loadEditableProfile(userId);
    let res;
    try {
      res = await getMediaConfirmClient().generateUserAvatarUploadUrl(
        userId,
        input.contentType,
        input.contentLength
      );
    } catch (err) {
      logger.warn("user avatar: upload-url mint failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
    }
    return {
      uploadUrl: res.uploadUrl,
      objectKey: res.objectKey,
      expiresIn: res.expiresIn,
      // The presign signs Content-Type; the PUT must send exactly this.
      headers: { "Content-Type": input.contentType },
    };
  },

  async unlinkSocialAccount(
    userId: string,
    provider: SocialProvider,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<UserAccount> {
    const res = await authClient.adminUnlinkSocial(userId, provider);
    if (!res.ok) {
      throw toClientError(res.errorCode);
    }

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.USER_SOCIAL_ACCOUNT_UNLINKED_BY_ADMIN,
      targetType: "user",
      targetId: userId,
      after: { provider },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    notifyAccountUpdated(userId);

    return userAccountService.getAccount(userId);
  },
};

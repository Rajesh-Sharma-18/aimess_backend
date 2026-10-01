import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { AdminUserEvents } from "@aimess/shared-types";

import type { UpdateUserAccountInput } from "../api/validators/user-account.validator.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import { authClient } from "../grpc/auth.client.js";
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

const DIRECTORY_FIELDS = ["email", "username", "firstName", "lastName"];

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

function notifyAccountUpdated(userId: string, actorId: string): void {
  publishAdminUserNotifySafe({
    userId,
    type: AdminUserEvents.USER_ACCOUNT_UPDATED,
    ...ACCOUNT_UPDATED_FALLBACK_COPY,
    data: { actorId },
  });
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
    const profilePatch = Object.fromEntries(
      PROFILE_FIELDS.filter((field) => input[field] !== undefined).map(
        (field) => [field, input[field]]
      )
    );
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
        notifyAccountUpdated(userId, actor.id);
        if (DIRECTORY_FIELDS.some((field) => field in changes)) {
          announceUserDirectoryChange();
        }
      }
    }

    return userAccountService.getAccount(userId);
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
    notifyAccountUpdated(userId, actor.id);

    return userAccountService.getAccount(userId);
  },
};

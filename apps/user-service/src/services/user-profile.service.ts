import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type {
  UserCreatedPayload,
  UserDeletedPayload,
} from "@aimess/shared-types";

import type { UpdateProfileInput } from "../api/validators/profile.validator.js";
import {
  Prisma,
  ProfileStatus,
  type ProfileGender,
} from "../generated/prisma/client.js";
import {
  buildDisplayName,
  dateOfBirthToUtcDate,
  formatDateOfBirth,
} from "../lib/profile-fields.util.js";
import {
  fromCachedProfileRecord,
  toCachedProfileRecord,
  userCache,
} from "../lib/user-cache.js";
import { resolveAuthAccountSummary } from "../lib/resolve-auth-account.js";
import type {
  AuthAccountSummary,
  SignInProvider,
} from "../types/auth-account.types.js";
import { isProfileComplete } from "../lib/profile-completion.util.js";
import { SCHEMA_DEFAULT_SCOPE, scopeAdmits } from "../lib/privacy-scope.js";
import { normalizeUsername } from "../lib/username.util.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import type {
  PublicUserProfileData,
  UserProfileData,
} from "../types/user-profile.types.js";
import { friendshipRepository } from "../repositories/friendship.repository.js";
import {
  buildFriendshipView,
  toSearchRelationship,
} from "../lib/friendship-view.js";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { avatarService } from "./avatar.service.js";
import { usernameService } from "./username.service.js";
import { publishProfileUpdatedSafe } from "../messaging/publish-profile-updated.js";

const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounded retries when a concurrent registration claims the same username. */
const USERNAME_CLAIM_MAX_ATTEMPTS = 5;

function isUniqueConstraintError(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** True when a P2002 was raised by the unique constraint on the given field. */
function isUniqueViolationOnField(
  error: Prisma.PrismaClientKnownRequestError,
  field: string
): boolean {
  // 1. Standard Prisma meta.target
  const target = error.meta?.target;
  if (Array.isArray(target) && target.includes(field)) {
    return true;
  }
  if (typeof target === "string" && target.includes(field)) {
    return true;
  }

  // 2. Driver adapter pg unique constraint fields
  const adapterError = error.meta?.driverAdapterError as
    | { cause?: { constraint?: { fields?: unknown } } }
    | undefined;
  const adapterFields = adapterError?.cause?.constraint?.fields;
  if (Array.isArray(adapterFields) && adapterFields.includes(field)) {
    return true;
  }

  // 3. Fallback: Parse from error message
  const message = error.message || "";
  if (
    message.includes(
      `Unique constraint failed on the fields: (\`${field}\`)`
    ) ||
    message.includes(`Unique constraint failed on the fields: (${field})`)
  ) {
    return true;
  }

  return false;
}

type ProfileRecord = {
  userId: string;
  username: string;
  account: string | null;
  isGoogleLogin: boolean;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: Date;
  gender: ProfileGender | null;
  avatarUrl: string | null;
  updatedAt: Date;
  deletedAt: Date | null;
};

type ProfileAuthSummary = {
  account: string | null;
  email: string | null;
  isGoogleLogin: boolean | null;
  isAppleLogin: boolean | null;
  primaryAccount: SignInProvider | null;
  googleEmail: string | null;
  appleEmail: string | null;
};

async function toProfileData(
  profile: Omit<ProfileRecord, "deletedAt">,
  authSummary: ProfileAuthSummary
): Promise<UserProfileData> {
  const avatarView = await avatarService.resolveViewUrlForClient(
    profile.avatarUrl
  );

  const avatar = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: profile.avatarUrl,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });

  return {
    userId: profile.userId,
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    bio: profile.bio,
    account:
      authSummary.account ?? (profile as { account?: string }).account ?? null,
    email: authSummary.email,
    // Prefer live linked-account status from auth-service; fall back to the
    // synced-at-registration DB flag when auth-service is unavailable.
    isGoogleLogin: authSummary.isGoogleLogin ?? profile.isGoogleLogin,
    isAppleLogin: authSummary.isAppleLogin ?? false,
    // Always present: null when unset, missing on older records, or auth down.
    primaryAccount: authSummary.primaryAccount ?? null,
    // Provider emails — non-null only while that provider is linked; null otherwise.
    googleEmail: authSummary.googleEmail ?? null,
    appleEmail: authSummary.appleEmail ?? null,
    dateOfBirth: formatDateOfBirth(profile.dateOfBirth),
    gender: profile.gender,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    avatar,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function isProviderConnected(
  account: Pick<AuthAccountSummary, "providers"> | null,
  provider: SignInProvider
): boolean | null {
  if (!account?.providers) {
    return null;
  }
  return account.providers.some(
    (entry) => entry.provider === provider && entry.connected
  );
}

/**
 * Email reported by a linked social provider. Reuses the providers already
 * fetched in the auth account summary (no extra query). Returns null when the
 * provider is not connected or reported no email — so googleEmail/appleEmail
 * are non-null only while that provider is linked.
 */
function getProviderEmail(
  account: Pick<AuthAccountSummary, "providers"> | null,
  provider: SignInProvider
): string | null {
  if (!account?.providers) {
    return null;
  }
  const entry = account.providers.find(
    (item) => item.provider === provider && item.connected
  );
  return entry?.providerEmail ?? null;
}

async function resolveProfileAuthSummary(
  userId: string
): Promise<ProfileAuthSummary> {
  const { account } = await resolveAuthAccountSummary(userId);
  return {
    account: account?.account ?? null,
    email: account?.email ?? null,
    isGoogleLogin: isProviderConnected(account, "GOOGLE"),
    isAppleLogin: isProviderConnected(account, "APPLE"),
    primaryAccount: account?.primaryAccount ?? null,
    googleEmail: getProviderEmail(account, "GOOGLE"),
    appleEmail: getProviderEmail(account, "APPLE"),
  };
}

async function loadProfileRecord(userId: string): Promise<ProfileRecord> {
  const cached = await userCache.getProfileRecord(userId);
  if (cached) {
    return fromCachedProfileRecord(cached);
  }

  const profile = await userProfileRepository.findByUserId(userId);
  if (!profile || profile.deletedAt) {
    throw new NotFoundError("USER_PROFILE_NOT_FOUND");
  }

  await userCache.setProfileRecord(toCachedProfileRecord(profile));

  return profile;
}

export const userProfileService = {
  /**
   * Another user's profile, viewer-scoped. Blocks 404 (never 403 — a 403 would
   * confirm the account exists). The `whoCanViewProfile` / `whoCanSeeOnlineStatus`
   * scopes have been stored-but-unenforced until now; they degrade the payload
   * instead of failing it, so the client always renders a card.
   */
  async getPublicProfile(
    viewerId: string,
    targetUserId: string
  ): Promise<PublicUserProfileData> {
    const notFound = () => new NotFoundError("USER_PROFILE_NOT_FOUND");

    const [profile, blockedByTarget, blockedByViewer] = await Promise.all([
      userProfileRepository.findPublicProfileByUserId(targetUserId),
      viewerId === targetUserId
        ? Promise.resolve(null)
        : friendshipRepository.findBlock(targetUserId, viewerId),
      viewerId === targetUserId
        ? Promise.resolve(null)
        : friendshipRepository.findBlock(viewerId, targetUserId),
    ]);

    if (!profile || profile.deletedAt) throw notFound();
    // Either direction hides the account entirely — same policy search already
    // applies via `findAllBlocks`.
    if (blockedByTarget) throw notFound();

    const isSelf = viewerId === targetUserId;
    const friendshipRow = isSelf
      ? null
      : await friendshipRepository.findByPair(viewerId, targetUserId);
    const view = buildFriendshipView(
      viewerId,
      friendshipRow,
      Boolean(blockedByViewer)
    );
    const isFriend = view.status === "ACCEPTED";
    const isDeletedUser = profile.status === ProfileStatus.DELETED;

    const [avatarView, avatar] = await Promise.all([
      avatarService.resolveViewUrlForClient(profile.avatarUrl),
      toMediaObject({
        bucket: env.MINIO_BUCKET_AVATARS,
        stored: profile.avatarUrl,
        prefixes: MEDIA_PREFIXES.userAvatars,
        strategy: mediaUrlStrategy,
      }),
    ]);

    const viewProfileScope =
      profile.privacySettings?.whoCanViewProfile ??
      SCHEMA_DEFAULT_SCOPE.whoCanViewProfile;
    // Only `whoCanViewProfile` offers FRIENDS_OF_FRIENDS here, and the lookup
    // is two indexed queries — so resolve the mutual-friend edge only when that
    // exact scope is set and the cheaper isSelf/isFriend answers do not settle it.
    const isFriendOfFriend =
      viewProfileScope === "FRIENDS_OF_FRIENDS" && !isSelf && !isFriend
        ? await friendshipRepository.hasMutualFriend(viewerId, targetUserId)
        : false;
    const relation = { isSelf, isFriend, isFriendOfFriend };

    const canViewProfile =
      !isDeletedUser && scopeAdmits(viewProfileScope, relation);
    const canSeePresence =
      canViewProfile &&
      scopeAdmits(
        // Missing row → FRIENDS (the schema default), NOT EVERYONE.
        profile.privacySettings?.whoCanSeeOnlineStatus ??
          SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus,
        relation
      );

    return {
      userId: profile.userId,
      username: profile.username,
      displayName: buildDisplayName(profile.firstName, profile.lastName),
      firstName: profile.firstName,
      lastName: profile.lastName,
      bio: canViewProfile ? profile.bio : null,
      avatarUrl: avatarView?.url ?? null,
      avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
      avatar,
      coverImageUrl: canViewProfile ? profile.coverImageUrl : null,
      isOnline: canSeePresence ? profile.isOnline : null,
      lastSeenAt:
        canSeePresence && profile.lastSeenAt
          ? profile.lastSeenAt.toISOString()
          : null,
      friendsCount: canViewProfile ? profile.friendsCount : null,
      groupsCount: canViewProfile ? profile.groupsCount : null,
      communitiesCount: canViewProfile ? profile.communitiesCount : null,
      isDeletedUser,
      // Search vocabulary (FRIEND/PENDING/NONE), not the raw ACCEPTED/... view —
      // it is what every existing client relationship parser already speaks.
      relationship: {
        friendshipId: friendshipRow?.id ?? null,
        ...toSearchRelationship(view),
      },
    };
  },

  async getMyProfile(userId: string): Promise<UserProfileData> {
    const profile = await loadProfileRecord(userId);
    const authSummary = await resolveProfileAuthSummary(userId);
    return toProfileData(profile, authSummary);
  },

  async createFromUserCreatedEvent(data: UserCreatedPayload): Promise<void> {
    const existing = await userProfileRepository.findByUserId(data.userId);
    if (existing) {
      logger.info(
        `User profile already exists for userId=${data.userId}, skipping`
      );
      return;
    }

    const displayName = data.account.slice(0, 50);

    for (
      let attempt = 1;
      attempt <= USERNAME_CLAIM_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const { username } = await usernameService.generateFromAccount(
        data.account
      );

      try {
        await userProfileRepository.createFromRegistration({
          userId: data.userId,
          account: data.account,
          username,
          displayName,
          isGoogleLogin: data.isGoogleLogin ?? false,
        });

        await userCache.onUsernameClaimed(username);

        logger.info(`User profile created for userId=${data.userId}`);
        return;
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }

        // Concurrent event for the same user already created the profile —
        // treat as an idempotent success so the message is ack'd.
        if (isUniqueViolationOnField(error, "userId")) {
          logger.info(
            `User profile already created concurrently for userId=${data.userId}, skipping`
          );
          return;
        }

        // Username race: another registration claimed this username first.
        // Mark it taken and regenerate the next candidate on the next attempt.
        if (isUniqueViolationOnField(error, "username")) {
          await userCache.onUsernameClaimed(username);
          logger.warn(
            `Username "${username}" was claimed concurrently; retrying generation (attempt ${attempt}/${USERNAME_CLAIM_MAX_ATTEMPTS})`
          );
          continue;
        }

        // Stale account collision: the new auth user legitimately owns this
        // account (auth_users.account is globally unique among ALL auth users,
        // including soft-deleted ones), so any existing profile holding it must
        // belong to a now-deleted auth user. We intentionally do NOT filter by
        // deletedAt — orphaned profiles can still be status=ACTIVE when the auth
        // user was hard-deleted without a user.deleted event — so we free the
        // account regardless of status, then retry the insert (now collision-free).
        if (isUniqueViolationOnField(error, "account")) {
          const { count } = await userProfileRepository.clearAccountValue(
            data.account
          );
          if (count === 0) {
            // Nothing was freed yet a P2002 on account fired: an anomaly worth
            // surfacing (e.g. the constraint moved). Let it retry/DLQ rather
            // than loop silently.
            logger.error(
              `Account "${data.account}" collided but no orphaned profile was freed (count=0); userId=${data.userId}`
            );
          } else {
            logger.warn(
              `Reclaimed stale account "${data.account}" from ${count} orphaned profile(s); retrying (attempt ${attempt}/${USERNAME_CLAIM_MAX_ATTEMPTS})`
            );
          }
          continue;
        }

        // Unknown unique constraint — surface it for retry/DLQ handling.
        throw error;
      }
    }

    throw new ConflictError("USER_USERNAME_TAKEN");
  },

  async softDeleteFromUserDeletedEvent(
    data: UserDeletedPayload
  ): Promise<void> {
    const profile = await userProfileRepository.findByUserId(data.userId);

    if (
      !profile ||
      profile.deletedAt ||
      profile.status === ProfileStatus.DELETED
    ) {
      logger.info(
        `User profile already deleted or missing for userId=${data.userId}, skipping`
      );
      return;
    }

    await userProfileRepository.softDelete(
      data.userId,
      new Date(data.deletedAt)
    );

    await userCache.invalidateProfile(data.userId);
    await userCache.onUsernameReleased(profile.username);

    logger.info(`User profile soft-deleted for userId=${data.userId}`);
  },

  async updateProfile(
    userId: string,
    input: UpdateProfileInput
  ): Promise<UserProfileData> {
    const profile = await userProfileRepository.findByUserId(userId);

    if (!profile || profile.deletedAt) {
      throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    }

    const previousUsername = profile.username;

    const updateData: {
      firstName?: string;
      lastName?: string;
      username?: string;
      bio?: string | null;
      dateOfBirth?: Date;
      gender?: ProfileGender | null;
      avatarUrl?: string | null;
      lastUsernameChangeAt?: Date;
    } = {};

    if (input.firstName !== undefined) {
      updateData.firstName = input.firstName;
    }

    if (input.lastName !== undefined) {
      updateData.lastName = input.lastName;
    }

    if (input.bio !== undefined) {
      updateData.bio = input.bio;
    }

    if (input.dateOfBirth !== undefined) {
      updateData.dateOfBirth = dateOfBirthToUtcDate(input.dateOfBirth);
    }

    if (input.gender !== undefined) {
      updateData.gender = input.gender;
    }

    if (input.avatarObjectKey !== undefined) {
      if (input.avatarObjectKey === null) {
        updateData.avatarUrl = null;
      } else {
        updateData.avatarUrl =
          await avatarService.resolveAvatarObjectKeyForProfile(
            userId,
            input.avatarObjectKey
          );
      }
    }

    if (input.username !== undefined) {
      const nextUsername = input.username;
      const currentNormalized = normalizeUsername(profile.username);

      if (nextUsername !== currentNormalized) {
        const lastChange = profile.lastUsernameChangeAt;
        if (
          lastChange &&
          Date.now() - lastChange.getTime() < USERNAME_CHANGE_COOLDOWN_MS
        ) {
          throw new BadRequestError("USER_USERNAME_CHANGE_TOO_SOON");
        }

        const { available } = await usernameService.validateAvailability(
          nextUsername,
          userId
        );

        if (!available) {
          throw new ConflictError("USER_USERNAME_TAKEN");
        }

        updateData.username = nextUsername;
        updateData.lastUsernameChangeAt = new Date();
      } else if (profile.username !== nextUsername) {
        // Same handle, different casing — store canonical lowercase without cooldown.
        updateData.username = nextUsername;
      }
    }

    // No-op PATCH: resolve account/email only here so an empty update still
    // returns the current profile without an unnecessary auth-service hop on
    // the mutate path.
    if (Object.keys(updateData).length === 0) {
      const authSummary = await resolveProfileAuthSummary(userId);
      return toProfileData(profile, authSummary);
    }

    const updated = await userProfileRepository.updateProfile(
      userId,
      updateData
    );

    await userCache.invalidateProfile(userId);

    publishProfileUpdatedSafe({
      userId,
      username: updated.username,
      displayName: buildDisplayName(updated.firstName, updated.lastName),
      avatarObjectKey: updated.avatarUrl ?? null,
      isProfileCompleted: isProfileComplete(updated),
      updatedAt: updated.updatedAt.toISOString(),
    });

    if (updateData.username && updateData.username !== previousUsername) {
      await userCache.onUsernameReleased(previousUsername);
      await userCache.onUsernameClaimed(updateData.username);
    }

    const authSummary = await resolveProfileAuthSummary(userId);
    return toProfileData(updated, authSummary);
  },
};

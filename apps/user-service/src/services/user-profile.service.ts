import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";
import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import type {
  UserCreatedPayload,
  UserDeletedPayload,
  UserRestoredPayload,
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
import {
  SCHEMA_DEFAULT_SCOPE,
  canSendFriendRequest,
  scopeAdmits,
  visibleIdentity,
} from "../lib/privacy-scope.js";
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
import { messagingGrpcClient } from "../grpc/messaging.client.js";
import { avatarService } from "./avatar.service.js";
import { usernameService } from "./username.service.js";
import { publishProfileUpdatedSafe } from "../messaging/publish-profile-updated.js";
import { emitProfileUpdatedSafe } from "../lib/profile-socket.js";

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
  emailVerified: boolean;
  hasPassword: boolean;
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
    emailVerified: authSummary.emailVerified,
    // Whether the delete-account / change-password flows will demand a password.
    // Clients MUST branch on this, never on `primaryAccount` — see the field doc.
    hasPassword: authSummary.hasPassword,
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
    // Auth-service down → treat as unverified rather than claiming verified.
    emailVerified: account?.emailVerified ?? false,
    // Auth-service down → assume a password IS required. The delete/change
    // flows will reject anyway, and prompting for one costs the user a
    // keystroke; suppressing the prompt makes the flow unusable.
    hasPassword: account?.hasPassword ?? true,
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
    // One-way, matching search (`lib/block-visibility.ts`): the TARGET's block
    // hides them from this viewer. The viewer's OWN block does not — a blocker
    // has to be able to open the profile of someone they blocked to review and
    // undo it. `blockedByViewer` is still carried into the relationship view
    // below so the client renders "Blocked" instead of an add-friend action.
    //
    // ONE exception, and it is the reason this whole audit happened: a pair
    // that already has a private conversation. Hiding the blocker made that
    // pair resolve to a DIFFERENT screen depending on the door — the chat list
    // opened the conversation (it holds a roomId and never asks about
    // friendship), while search and the profile 404'd or reported NONE and
    // offered "Send Request" for a chat with years of history in it. The
    // conversation is already visible to this viewer from their own inbox, so
    // the block hides nothing here that they cannot already see; it only made
    // the surfaces disagree. Pairs with NO conversation keep the 404 — there
    // the block still genuinely removes the blocker from the viewer's world.
    const conversationWithBlocker =
      blockedByTarget &&
      (await messagingGrpcClient.resolvePrivateRooms(viewerId, [targetUserId]))
        .length > 0;
    if (blockedByTarget && !conversationWithBlocker) throw notFound();

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

    const viewProfileScope =
      profile.privacySettings?.whoCanViewProfile ??
      SCHEMA_DEFAULT_SCOPE.whoCanViewProfile;
    const friendRequestScope =
      profile.privacySettings?.whoCanSendFriendRequests ??
      SCHEMA_DEFAULT_SCOPE.whoCanSendFriendRequests;
    // `whoCanViewProfile` and `whoCanSendFriendRequests` both offer
    // FRIENDS_OF_FRIENDS, and the lookup is two indexed queries — so resolve
    // the mutual-friend edge once, only when EITHER scope actually depends on
    // it and the cheaper isSelf/isFriend answers do not settle it.
    const needsMutualFriend =
      viewProfileScope === "FRIENDS_OF_FRIENDS" ||
      friendRequestScope === "FRIENDS_OF_FRIENDS";
    const isFriendOfFriend =
      needsMutualFriend && !isSelf && !isFriend
        ? await friendshipRepository.hasMutualFriend(viewerId, targetUserId)
        : false;
    const relation = { isSelf, isFriend, isFriendOfFriend };

    // A blocker's profile CONTENT stays closed to the person they blocked even
    // when the card itself is now reachable: the exception above exists to keep
    // the conversation openable, not to hand back a profile the block took
    // away.
    const canViewProfile =
      !isDeletedUser &&
      !blockedByTarget &&
      scopeAdmits(viewProfileScope, relation);

    // Name + avatar are NOT gated by `whoCanViewProfile` — a profile card has
    // to stay recognizable for the strangers who are allowed to find it. Only a
    // DELETED account is blanked, and resolving its avatar key as null yields
    // the same "no avatar" shape as a user who never set one.
    const identity = visibleIdentity(profile, { anonymize: isDeletedUser });
    const [avatarView, avatar] = await Promise.all([
      avatarService.resolveViewUrlForClient(
        identity.avatarAllowed ? profile.avatarUrl : null
      ),
      toMediaObject({
        bucket: env.MINIO_BUCKET_AVATARS,
        stored: identity.avatarAllowed ? profile.avatarUrl : null,
        prefixes: MEDIA_PREFIXES.userAvatars,
        strategy: mediaUrlStrategy,
      }),
    ]);

    // BLOCKED collapses to NONE in this vocabulary — `isBlockedByMe` below and
    // the explicit block flag passed to `canSendFriendRequest` carry that state.
    const searchRelationship = toSearchRelationship(view);

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
      displayName: identity.fullName
        ? buildDisplayName(profile.firstName, profile.lastName)
        : null,
      firstName: identity.firstName,
      lastName: identity.lastName,
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
      isBlockedByMe: Boolean(blockedByViewer),
      /**
       * The TARGET blocks the VIEWER. Only ever true on the reachable-because-
       * a-conversation-exists path above; otherwise this endpoint 404s and the
       * question never arises. The client needs it to render the conversation's
       * disabled composer with the right reason — "you can't send messages to
       * this user" is a different situation, and a different way out, from a
       * declined friend request.
       */
      isBlockedByPeer: Boolean(blockedByTarget),
      // Search vocabulary (FRIEND/PENDING/NONE), not the raw ACCEPTED/... view —
      // it is what every existing client relationship parser already speaks.
      relationship: {
        friendshipId: friendshipRow?.id ?? null,
        ...searchRelationship,
        // Same gate `friendshipService.sendRequest` enforces — the profile
        // screen renders "Add Friend" from this and nothing else. A deleted
        // account can never receive one, whatever its stored scope says.
        canSendRequest:
          !isDeletedUser &&
          canSendFriendRequest(profile, relation, {
            status: searchRelationship.status,
            // BOTH directions. A block by the target no longer always 404s —
            // a pair with a conversation resolves — and `sendRequest` refuses
            // either direction with FRIEND_BLOCKED, so offering the action here
            // would put a button on a call the API rejects.
            isBlockedEitherWay: Boolean(blockedByViewer || blockedByTarget),
          }),
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

    // Seed the profile from the verified social provider name when the event
    // carried one; otherwise leave the fields empty so the user fills them in
    // on the profile-details step. A blank/whitespace value is treated as
    // "not provided".
    const firstName = data.firstName?.trim().slice(0, 50) ?? "";
    const lastName = data.lastName?.trim().slice(0, 50) ?? "";

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
          firstName,
          lastName,
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

    // Deletion IS an identity change, so it rides the identity-change fanout
    // rather than inventing a parallel one. Every consumer of
    // `user.profile_updated` already does exactly what deletion needs, and
    // does it for the whole platform in one hop:
    //   - chat-service   → drops `user:snapshot:<userId>` from Redis, so the
    //                      next private-list / group-roster / message read
    //                      re-pulls the (now anonymized) gRPC snapshot;
    //   - community-service → overwrites every stored member snapshot with
    //                      these values AND broadcasts `community:member:updated`
    //                      into each of the user's communities, which is the
    //                      live member-list refresh with no page reload;
    //   - auth-service   → mirrors isProfileCompleted only (unaffected).
    // Targeted by userId — nothing is flushed wholesale.
    //
    // The values published here are the SAME anonymized triple the
    // BulkGetUserSnapshots RPC now returns, so a consumer that persists them
    // and a consumer that re-fetches them cannot disagree.
    publishProfileUpdatedSafe({
      userId: data.userId,
      username: "",
      displayName: DELETED_ACCOUNT_DISPLAY_NAME,
      avatarObjectKey: null,
      // Carried through unchanged: this flag describes whether the profile's
      // required fields were filled in, which deletion does not answer. Auth
      // mirrors it for post-login routing, and flipping it here would misroute
      // the user if the account is restored inside the 30-day grace period.
      isProfileCompleted: isProfileComplete(profile),
      updatedAt: data.deletedAt,
      isDeleted: true,
    });

    logger.info(`User profile soft-deleted for userId=${data.userId}`);
  },

  /**
   * Exact inverse of {@link softDeleteFromUserDeletedEvent}, driven by the
   * `user.restored` event auth-service publishes when a Super Admin
   * reactivates a soft-deleted account.
   *
   * This one method is the whole platform-wide restore, for the same reason
   * deletion was one method: the delete never destroyed anything. It set
   * `deletedAt` + `status` on this row and left every other column alone, and
   * the anonymized identity the rest of the platform shows is produced from
   * those flags at read time (the BulkGetUserSnapshots RPC in grpc/server.ts)
   * or persisted as a denormalized copy of that read-time value
   * (community-service member snapshots, chat-service's `user:snapshot:<id>`
   * Redis entry). Nothing else in the system consumes `user.deleted` at all —
   * chats, messages, attachments, group and community memberships,
   * friendships, notifications and media were never touched.
   *
   * So clearing the two flags restores every server-side read path, and
   * re-publishing `user.profile_updated` with the REAL identity and
   * `isDeleted` absent walks the same fanout the deletion used, in reverse:
   *   - chat-service   → drops `user:snapshot:<userId>`, so DM lists, group
   *                      rosters and message headers re-pull the real name and
   *                      avatar, and emits `user:profile_updated` to the user's
   *                      peers and every active group room instead of the
   *                      `user:account_deleted` it emitted on delete;
   *   - community-service → overwrites every "Deleted Account" member snapshot
   *                      and `lastActivityUsername` with the real values and
   *                      re-broadcasts `community:member:updated` into each of
   *                      the user's communities, refreshing live member lists;
   *   - auth-service   → mirrors isProfileCompleted only (unchanged).
   *
   * Idempotent: a redelivered event finds the profile already ACTIVE and exits
   * without republishing.
   */
  async restoreFromUserRestoredEvent(data: UserRestoredPayload): Promise<void> {
    const profile = await userProfileRepository.findByUserId(data.userId);

    if (!profile) {
      logger.warn(
        `User profile missing for userId=${data.userId}, cannot restore`
      );
      return;
    }

    if (!profile.deletedAt && profile.status !== ProfileStatus.DELETED) {
      logger.info(
        `User profile already active for userId=${data.userId}, skipping`
      );
      return;
    }

    const restored = await userProfileRepository.restore(data.userId);

    await userCache.invalidateProfile(data.userId);
    // Symmetric to the `onUsernameReleased` the delete performed: the username
    // is in use again, so the availability cache must stop offering it.
    await userCache.onUsernameClaimed(restored.username);

    publishProfileUpdatedSafe({
      userId: data.userId,
      username: restored.username,
      displayName: buildDisplayName(restored.firstName, restored.lastName),
      avatarObjectKey: restored.avatarUrl ?? null,
      isProfileCompleted: isProfileComplete(restored),
      updatedAt: data.restoredAt,
      // Absent, not `false`: consumers branch on `=== true`, and an ordinary
      // identity-change event is exactly what a restore is to them.
    });

    logger.info(`User profile restored for userId=${data.userId}`);
  },

  /**
   * `editorSessionId` is the caller's own session. It is excluded from the
   * realtime fan-out below so the editing device does not receive an echo of
   * the change it already got back in this call's HTTP response.
   */
  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
    editorSessionId?: string
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

    // Separate delivery mechanism, not a replacement for the RabbitMQ fanout
    // above: that one keeps other SERVICES' denormalized snapshots fresh, this
    // one tells the user's own other DEVICES to re-fetch. Both must fire.
    emitProfileUpdatedSafe(
      userId,
      updated.updatedAt.toISOString(),
      editorSessionId
    );

    if (updateData.username && updateData.username !== previousUsername) {
      await userCache.onUsernameReleased(previousUsername);
      await userCache.onUsernameClaimed(updateData.username);
    }

    publishAdminActivitySafe({
      actorId: userId,
      action: USER_AUDIT_ACTIONS.USER_PROFILE_UPDATED,
      targetType: "user",
      targetId: userId,
      after: { changedFields: Object.keys(updateData) },
    });

    const authSummary = await resolveProfileAuthSummary(userId);
    return toProfileData(updated, authSummary);
  },
};

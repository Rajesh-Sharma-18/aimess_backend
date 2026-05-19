import { BadRequestError, ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { UserCreatedPayload } from "@aimess/shared-types";

import type { UpdateProfileInput } from "../api/validators/profile.validator.js";
import type { ProfileGender } from "../generated/prisma/client.js";
import {
  dateOfBirthToUtcDate,
  formatDateOfBirth,
} from "../lib/profile-fields.util.js";
import {
  fromCachedProfileRecord,
  toCachedProfileRecord,
  userCache,
} from "../lib/user-cache.js";
import { resolveAuthAccountSummary } from "../lib/resolve-auth-account.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import type {
  UserProfileData,
  UserProfileResponse,
} from "../types/user-profile.types.js";
import { avatarService } from "./avatar.service.js";
import { usernameService } from "./username.service.js";

const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

type ProfileRecord = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: Date;
  gender: ProfileGender | null;
  avatarUrl: string | null;
  updatedAt: Date;
  deletedAt: Date | null;
};

async function toProfileData(
  profile: Omit<ProfileRecord, "deletedAt">
): Promise<UserProfileData> {
  const avatarView = await avatarService.resolveViewUrlForClient(
    profile.avatarUrl
  );

  return {
    userId: profile.userId,
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    bio: profile.bio,
    dateOfBirth: formatDateOfBirth(profile.dateOfBirth),
    gender: profile.gender,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    updatedAt: profile.updatedAt.toISOString(),
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
  async getMyProfile(
    userId: string,
    accessToken: string
  ): Promise<UserProfileResponse> {
    const profile = await loadProfileRecord(userId);
    const profileData = await toProfileData(profile);
    const { account, accountStatus } = await resolveAuthAccountSummary(
      userId,
      accessToken
    );

    return { ...profileData, account, accountStatus };
  },

  async createFromUserCreatedEvent(data: UserCreatedPayload): Promise<void> {
    const existing = await userProfileRepository.findByUserId(data.userId);
    if (existing) {
      logger.info(
        `User profile already exists for userId=${data.userId}, skipping`
      );
      return;
    }

    const { username } = await usernameService.generateFromAccount(
      data.account
    );

    await userProfileRepository.createFromRegistration({
      userId: data.userId,
      username,
      displayName: data.account.slice(0, 50),
    });

    await userCache.onUsernameClaimed(username);

    logger.info(`User profile created for userId=${data.userId}`);
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

    if (input.username !== undefined && input.username !== profile.username) {
      const lastChange = profile.lastUsernameChangeAt;
      if (
        lastChange &&
        Date.now() - lastChange.getTime() < USERNAME_CHANGE_COOLDOWN_MS
      ) {
        throw new BadRequestError("USER_USERNAME_CHANGE_TOO_SOON");
      }

      const { available } = await usernameService.validateAvailability(
        input.username,
        userId
      );

      if (!available) {
        throw new ConflictError("USER_USERNAME_TAKEN");
      }

      updateData.username = input.username;
      updateData.lastUsernameChangeAt = new Date();
    }

    if (Object.keys(updateData).length === 0) {
      return toProfileData(profile);
    }

    const updated = await userProfileRepository.updateProfile(
      userId,
      updateData
    );

    await userCache.invalidateProfile(userId);

    if (updateData.username && updateData.username !== previousUsername) {
      await userCache.onUsernameReleased(previousUsername);
      await userCache.onUsernameClaimed(updateData.username);
    }

    return toProfileData(updated);
  },
};

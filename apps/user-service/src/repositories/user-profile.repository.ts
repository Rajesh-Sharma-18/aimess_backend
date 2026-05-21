import {
  ProfileStatus,
  type ProfileGender,
} from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { normalizeUsername } from "../lib/username.util.js";

const PLACEHOLDER_DATE_OF_BIRTH = new Date("2000-01-01");

export const userProfileRepository = {
  findByUserId(userId: string) {
    return prisma.userProfile.findUnique({ where: { userId } });
  },

  /** Case-insensitive — canonical storage is lowercase; legacy rows may differ in casing. */
  findByUsername(username: string) {
    const normalized = normalizeUsername(username);
    return prisma.userProfile.findFirst({
      where: {
        username: { equals: normalized, mode: "insensitive" },
      },
    });
  },

  updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      username?: string;
      bio?: string | null;
      dateOfBirth?: Date;
      gender?: ProfileGender | null;
      avatarUrl?: string | null;
      lastUsernameChangeAt?: Date;
    }
  ) {
    return prisma.userProfile.update({
      where: { userId },
      data,
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        dateOfBirth: true,
        gender: true,
        avatarUrl: true,
        updatedAt: true,
      },
    });
  },

  softDelete(userId: string, deletedAt: Date) {
    return prisma.userProfile.update({
      where: { userId },
      data: {
        status: ProfileStatus.DELETED,
        deletedAt,
      },
    });
  },

  createFromRegistration(params: {
    userId: string;
    username: string;
    displayName: string;
  }) {
    const { userId, username, displayName } = params;

    return prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.create({
        data: {
          userId,
          username,
          firstName: displayName,
          lastName: "User",
          dateOfBirth: PLACEHOLDER_DATE_OF_BIRTH,
        },
      });

      await tx.privacySettings.create({ data: { userId } });
      await tx.chatSettings.create({ data: { userId } });
      await tx.appSettings.create({ data: { userId } });
      await tx.notificationSettings.create({ data: { userId } });
      await tx.liveStreamSettings.create({ data: { userId } });

      return profile;
    });
  },
};

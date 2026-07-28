import type {
  AppTheme,
  AutoDeleteTimer,
  CallPrivacyScope,
  LiveStreamQuality,
  PrivacyScope,
} from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

export type SettingsBundle = {
  deletedAt: Date | null;
  privacySettings: {
    whoCanFindMe: PrivacyScope;
    whoCanSendFriendRequests: PrivacyScope;
    whoCanSeeOnlineStatus: PrivacyScope;
    whoCanViewProfile: PrivacyScope;
    whoCanCallMe: CallPrivacyScope;
    updatedAt: Date;
  } | null;
  chatSettings: {
    autoDeleteTimer: AutoDeleteTimer;
    typingIndicators: boolean;
    readReceipts: boolean;
    updatedAt: Date;
  } | null;
  appSettings: {
    language: string;
    theme: AppTheme;
    updatedAt: Date;
  } | null;
  notificationSettings: {
    chatEnabled: boolean;
    callEnabled: boolean;
    friendRequestEnabled: boolean;
    systemEnabled: boolean;
    communityEnabled: boolean;
    liveStreamEnabled: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietHoursDays: number[];
    updatedAt: Date;
  } | null;
  liveStreamSettings: {
    defaultVideoQuality: LiveStreamQuality;
    updatedAt: Date;
  } | null;
  callPrivacyAllowList: { allowedUserId: string }[];
};

export type PrivacySettingsUpdate = {
  whoCanFindMe?: PrivacyScope;
  whoCanSendFriendRequests?: PrivacyScope;
  whoCanSeeOnlineStatus?: PrivacyScope;
  whoCanViewProfile?: PrivacyScope;
  whoCanCallMe?: CallPrivacyScope;
};

export type ChatSettingsUpdate = {
  autoDeleteTimer?: AutoDeleteTimer;
  typingIndicators?: boolean;
  readReceipts?: boolean;
};

export type AppSettingsUpdate = {
  language?: string;
  theme?: AppTheme;
};

export type NotificationSettingsUpdate = {
  chatEnabled?: boolean;
  callEnabled?: boolean;
  friendRequestEnabled?: boolean;
  systemEnabled?: boolean;
  communityEnabled?: boolean;
  liveStreamEnabled?: boolean;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursDays?: number[];
};

export type LiveStreamSettingsUpdate = {
  defaultVideoQuality?: LiveStreamQuality;
};

const notificationSelect = {
  chatEnabled: true,
  callEnabled: true,
  friendRequestEnabled: true,
  systemEnabled: true,
  communityEnabled: true,
  liveStreamEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  quietHoursDays: true,
  updatedAt: true,
} as const;

export type NotificationSettingsRow = {
  chatEnabled: boolean;
  callEnabled: boolean;
  friendRequestEnabled: boolean;
  systemEnabled: boolean;
  communityEnabled: boolean;
  liveStreamEnabled: boolean;
  showPreview: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursDays: number[];
};

export const userSettingsRepository = {
  /**
   * Notification preferences only — consumed by the GetNotificationSettings
   * gRPC handler. Returns null when the row does not exist yet (callers default
   * to "all enabled").
   */
  findNotificationSettings(
    userId: string
  ): Promise<NotificationSettingsRow | null> {
    return prisma.notificationSettings.findUnique({
      where: { userId },
      select: {
        chatEnabled: true,
        callEnabled: true,
        friendRequestEnabled: true,
        systemEnabled: true,
        communityEnabled: true,
        liveStreamEnabled: true,
        showPreview: true,
        quietHoursEnabled: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        quietHoursDays: true,
      },
    });
  },

  /**
   * Callee-scoped call-privacy read for the chat-service `initiateCall` gate.
   * Returns default FRIENDS + empty allow-list when no row exists yet (matches
   * the Prisma-schema default so unset users still receive calls from friends).
   */
  async findCallPrivacy(
    userId: string
  ): Promise<{ whoCanCallMe: string; allowedUserIds: string[] }> {
    const row = await prisma.userProfile.findUnique({
      where: { userId },
      select: {
        privacySettings: { select: { whoCanCallMe: true } },
        callPrivacyAllowList: { select: { allowedUserId: true } },
      },
    });
    return {
      whoCanCallMe: row?.privacySettings?.whoCanCallMe ?? "FRIENDS",
      allowedUserIds: (row?.callPrivacyAllowList ?? []).map(
        (r) => r.allowedUserId
      ),
    };
  },

  findSettingsBundle(userId: string): Promise<SettingsBundle | null> {
    return prisma.userProfile.findUnique({
      where: { userId },
      select: {
        deletedAt: true,
        privacySettings: {
          select: {
            whoCanFindMe: true,
            whoCanSendFriendRequests: true,
            whoCanSeeOnlineStatus: true,
            whoCanViewProfile: true,
            whoCanCallMe: true,
            updatedAt: true,
          },
        },
        chatSettings: {
          select: {
            autoDeleteTimer: true,
            typingIndicators: true,
            readReceipts: true,
            updatedAt: true,
          },
        },
        appSettings: {
          select: {
            language: true,
            theme: true,
            updatedAt: true,
          },
        },
        notificationSettings: { select: notificationSelect },
        liveStreamSettings: {
          select: { defaultVideoQuality: true, updatedAt: true },
        },
        callPrivacyAllowList: {
          select: { allowedUserId: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  },

  ensureDefaultSettings(userId: string): Promise<void> {
    return prisma.$transaction(async (tx) => {
      await tx.privacySettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.chatSettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.appSettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.notificationSettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.liveStreamSettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
    });
  },

  findCallAllowedIds(ownerId: string): Promise<string[]> {
    return prisma.callAllowedFriend
      .findMany({ where: { ownerId }, select: { allowedUserId: true } })
      .then((rows) => rows.map((r) => r.allowedUserId));
  },

  async listCallAllowedFriends(
    ownerId: string,
    params: { cursor?: string; limit: number }
  ): Promise<{
    profiles: {
      userId: string;
      username: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
    }[];
    nextCursor: string | null;
  }> {
    const rows = await prisma.callAllowedFriend.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: params.limit + 1,
      ...(params.cursor ? { skip: 1, cursor: { id: params.cursor } } : {}),
      select: { id: true, allowedUserId: true },
    });

    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    if (page.length === 0) return { profiles: [], nextCursor };

    const profileList = await prisma.userProfile.findMany({
      where: {
        userId: { in: page.map((r) => r.allowedUserId) },
        deletedAt: null,
      },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    const profileMap = new Map(profileList.map((p) => [p.userId, p]));

    const profiles = page
      .map((r) => profileMap.get(r.allowedUserId))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);

    return { profiles, nextCursor };
  },

  async addCallAllowedFriend(ownerId: string, friendId: string): Promise<void> {
    await prisma.callAllowedFriend.createMany({
      data: [{ ownerId, allowedUserId: friendId }],
      skipDuplicates: true,
    });
  },

  async removeCallAllowedFriend(
    ownerId: string,
    friendId: string
  ): Promise<void> {
    await prisma.callAllowedFriend.deleteMany({
      where: { ownerId, allowedUserId: friendId },
    });
  },

  countCallAllowedFriends(ownerId: string): Promise<number> {
    return prisma.callAllowedFriend.count({ where: { ownerId } });
  },

  updateSettings(
    userId: string,
    data: {
      privacy?: PrivacySettingsUpdate;
      chat?: ChatSettingsUpdate;
      app?: AppSettingsUpdate;
      notifications?: NotificationSettingsUpdate;
      liveStream?: LiveStreamSettingsUpdate;
      callAllowedFriendIds?: string[];
    }
  ): Promise<void> {
    return prisma.$transaction(async (tx) => {
      if (data.privacy && Object.keys(data.privacy).length > 0) {
        await tx.privacySettings.upsert({
          where: { userId },
          create: { userId, ...data.privacy },
          update: data.privacy,
        });
      }

      if (data.chat && Object.keys(data.chat).length > 0) {
        await tx.chatSettings.upsert({
          where: { userId },
          create: { userId, ...data.chat },
          update: data.chat,
        });
      }

      if (data.app && Object.keys(data.app).length > 0) {
        await tx.appSettings.upsert({
          where: { userId },
          create: { userId, ...data.app },
          update: data.app,
        });
      }

      if (data.notifications && Object.keys(data.notifications).length > 0) {
        await tx.notificationSettings.upsert({
          where: { userId },
          create: { userId, ...data.notifications },
          update: data.notifications,
        });
      }

      if (data.liveStream && Object.keys(data.liveStream).length > 0) {
        await tx.liveStreamSettings.upsert({
          where: { userId },
          create: { userId, ...data.liveStream },
          update: data.liveStream,
        });
      }

      if (data.callAllowedFriendIds !== undefined) {
        await tx.callAllowedFriend.deleteMany({ where: { ownerId: userId } });

        if (data.callAllowedFriendIds.length > 0) {
          await tx.callAllowedFriend.createMany({
            data: data.callAllowedFriendIds.map((allowedUserId) => ({
              ownerId: userId,
              allowedUserId,
            })),
            skipDuplicates: true,
          });
        }
      }
    });
  },
};

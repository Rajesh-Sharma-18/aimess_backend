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
    autoDeleteDefaultMode: string;
    autoDeleteDefaultTtlSeconds: number | null;
    autoDeleteDefaultVersion: number;
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
    showPreview: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietHoursDays: number[];
    quietHoursTimezone: string | null;
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
  autoDeleteDefaultMode?: string;
  autoDeleteDefaultTtlSeconds?: number | null;
  autoDeleteDefaultVersion?: number;
  typingIndicators?: boolean;
  readReceipts?: boolean;
  /** Stamped by the service on an OFF → ON transition only — never by a client. */
  readReceiptsEnabledAt?: Date;
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
  showPreview?: boolean;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursDays?: number[];
  quietHoursTimezone?: string | null;
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
  showPreview: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  quietHoursDays: true,
  quietHoursTimezone: true,
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
  quietHoursTimezone: string | null;
};

export const userSettingsRepository = {
  /**
   * Notification preferences only — consumed by the GetNotificationSettings
   * gRPC handler. Returns null when the row does not exist yet (callers default
   * to "all enabled").
   */
  /**
   * The user's chosen app language, or "" when they have no AppSettings row
   * yet. Read alongside the notification preferences so a push can be rendered
   * in the RECIPIENT's language rather than whoever triggered the event.
   */
  async findAppLanguage(userId: string): Promise<string> {
    const row = await prisma.appSettings.findUnique({
      where: { userId },
      select: { language: true },
    });
    return row?.language ?? "";
  },

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
        quietHoursTimezone: true,
      },
    });
  },

  /**
   * Callee-scoped call-privacy read for the chat-service `initiateCall` gate.
   * Returns FRIENDS + an empty allow-list when no row exists yet. This is
   * deliberately STRICTER than the column default (EVERYONE): profile creation
   * always writes the row, so a missing one means something went wrong, and a
   * failure must not hand strangers the ability to ring the user.
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

  /**
   * The account-wide Settings → Chat block, for the chat-service send/read
   * paths and the gateway's typing gate. No settings row yet → the schema
   * defaults (OFF, and both indicators ON).
   */
  async findChatSettings(userId: string): Promise<{
    autoDeleteTimer: string;
    autoDeleteDefaultMode: string;
    autoDeleteDefaultTtlSeconds: number | null;
    autoDeleteDefaultVersion: number;
    typingIndicators: boolean;
    readReceipts: boolean;
    readReceiptsEnabledAt: Date | null;
  }> {
    const row = await prisma.chatSettings.findUnique({
      where: { userId },
      select: {
        autoDeleteTimer: true,
        autoDeleteDefaultMode: true,
        autoDeleteDefaultTtlSeconds: true,
        autoDeleteDefaultVersion: true,
        typingIndicators: true,
        readReceipts: true,
        readReceiptsEnabledAt: true,
      },
    });
    return {
      autoDeleteTimer: row?.autoDeleteTimer ?? "OFF",
      // Version 0 means "never explicitly saved", which the chat-service
      // dual-read uses to keep honouring the legacy enum. Reporting "" rather
      // than the column default is what makes that distinction survive the RPC.
      autoDeleteDefaultMode:
        (row?.autoDeleteDefaultVersion ?? 0) > 0
          ? (row?.autoDeleteDefaultMode ?? "OFF")
          : "",
      autoDeleteDefaultTtlSeconds: row?.autoDeleteDefaultTtlSeconds ?? null,
      autoDeleteDefaultVersion: row?.autoDeleteDefaultVersion ?? 0,
      typingIndicators: row?.typingIndicators ?? true,
      readReceipts: row?.readReceipts ?? true,
      readReceiptsEnabledAt: row?.readReceiptsEnabledAt ?? null,
    };
  },

  /**
   * Addressee-scoped `whoCanSendFriendRequests` for the `sendRequest` gate.
   * `null` means no settings row yet → the caller's `scopeAdmits` falls back to
   * the schema default (EVERYONE), so unset users still receive requests.
   */
  async findFriendRequestPrivacy(userId: string): Promise<string | null> {
    const row = await prisma.privacySettings.findUnique({
      where: { userId },
      select: { whoCanSendFriendRequests: true },
    });
    return row?.whoCanSendFriendRequests ?? null;
  },

  /**
   * `whoCanSendFriendRequests` for many users at once — backs the bulk gRPC
   * `checkFriendships` relationship map, which has to answer add-friend
   * eligibility for a whole candidate list in one round-trip. Users absent
   * from the result have no settings row (→ the schema default, EVERYONE).
   */
  async findFriendRequestScopes(
    userIds: string[]
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.privacySettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, whoCanSendFriendRequests: true },
    });
    return new Map(rows.map((r) => [r.userId, r.whoCanSendFriendRequests]));
  },

  /**
   * `whoCanSeeOnlineStatus` for many users at once — backs the socket
   * `presence:subscribe` gate, which filters a whole peer list per call.
   * Users absent from the result have no settings row (→ EVERYONE).
   */
  async findOnlineVisibilityScopes(
    userIds: string[]
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.privacySettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, whoCanSeeOnlineStatus: true },
    });
    return new Map(rows.map((r) => [r.userId, r.whoCanSeeOnlineStatus]));
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
            autoDeleteDefaultMode: true,
            autoDeleteDefaultTtlSeconds: true,
            autoDeleteDefaultVersion: true,
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

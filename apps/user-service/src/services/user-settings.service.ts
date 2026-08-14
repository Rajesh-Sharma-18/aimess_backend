import { BadRequestError, NotFoundError, ConflictError } from "@aimess/errors";

import type { UpdateSettingsInput } from "../api/validators/settings.validator.js";
import { emitSettingsUpdatedSafe } from "../lib/friend-socket.js";
import { publishSettingsUpdatedSafe } from "../messaging/publish-settings-updated.js";
import {
  type NotificationSettingsUpdate,
  type PrivacySettingsUpdate,
  type SettingsBundle,
  userSettingsRepository,
} from "../repositories/user-settings.repository.js";
import type { UserSettingsResponse } from "../types/user-settings.types.js";

function mapSettingsBundle(bundle: SettingsBundle): UserSettingsResponse {
  const privacy = bundle.privacySettings!;
  const chat = bundle.chatSettings!;
  const app = bundle.appSettings!;
  const notifications = bundle.notificationSettings!;
  const liveStream = bundle.liveStreamSettings!;

  return {
    privacy: {
      whoCanFindMe: privacy.whoCanFindMe,
      whoCanSendFriendRequests: privacy.whoCanSendFriendRequests,
      whoCanSeeOnlineStatus: privacy.whoCanSeeOnlineStatus,
      whoCanViewProfile: privacy.whoCanViewProfile,
      whoCanCallMe: privacy.whoCanCallMe,
      callAllowedFriendIds: bundle.callPrivacyAllowList.map(
        (row) => row.allowedUserId
      ),
    },
    chat: {
      autoDeleteTimer: chat.autoDeleteTimer,
      typingIndicators: chat.typingIndicators,
      readReceipts: chat.readReceipts,
    },
    app: {
      language: app.language,
      theme: app.theme,
    },
    notifications: {
      chat: notifications.chatEnabled,
      call: notifications.callEnabled,
      friendRequest: notifications.friendRequestEnabled,
      system: notifications.systemEnabled,
      community: notifications.communityEnabled,
      liveStream: notifications.liveStreamEnabled,
      showPreview: notifications.showPreview,
      quietHours: {
        enabled: notifications.quietHoursEnabled,
        start: notifications.quietHoursStart,
        end: notifications.quietHoursEnd,
        days: notifications.quietHoursDays,
        timezone: notifications.quietHoursTimezone,
      },
    },
    liveStream: {
      defaultVideoQuality: liveStream.defaultVideoQuality,
    },
    updatedAt: new Date(
      Math.max(
        privacy.updatedAt.getTime(),
        chat.updatedAt.getTime(),
        app.updatedAt.getTime(),
        notifications.updatedAt.getTime(),
        liveStream.updatedAt.getTime()
      )
    ).toISOString(),
  };
}

async function loadSettingsBundle(userId: string): Promise<SettingsBundle> {
  let bundle = await userSettingsRepository.findSettingsBundle(userId);

  if (!bundle || bundle.deletedAt) {
    throw new NotFoundError("USER_PROFILE_NOT_FOUND");
  }

  if (!isComplete(bundle)) {
    await userSettingsRepository.ensureDefaultSettings(userId);
    bundle = await userSettingsRepository.findSettingsBundle(userId);
  }

  if (!bundle || !isComplete(bundle)) {
    throw new NotFoundError("USER_SETTINGS_NOT_FOUND");
  }

  return bundle;
}

function isComplete(bundle: SettingsBundle): boolean {
  return Boolean(
    bundle.privacySettings &&
    bundle.chatSettings &&
    bundle.appSettings &&
    bundle.notificationSettings &&
    bundle.liveStreamSettings
  );
}

function normalizeCallAllowedFriendIds(
  userId: string,
  ids: string[] | undefined
): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }

  const uniqueIds = [...new Set(ids)];

  if (uniqueIds.includes(userId)) {
    throw new BadRequestError("USER_SETTINGS_INVALID_CALL_ALLOW_LIST");
  }

  return uniqueIds;
}

/** Translate the API's notification shape into DB column names. */
function toNotificationUpdate(
  input: NonNullable<UpdateSettingsInput["notifications"]>
): NotificationSettingsUpdate {
  const update: NotificationSettingsUpdate = {};

  if (input.chat !== undefined) update.chatEnabled = input.chat;
  if (input.call !== undefined) update.callEnabled = input.call;
  if (input.friendRequest !== undefined) {
    update.friendRequestEnabled = input.friendRequest;
  }
  if (input.system !== undefined) update.systemEnabled = input.system;
  if (input.community !== undefined) update.communityEnabled = input.community;
  if (input.liveStream !== undefined) {
    update.liveStreamEnabled = input.liveStream;
  }
  if (input.showPreview !== undefined) update.showPreview = input.showPreview;

  if (input.quietHours) {
    const qh = input.quietHours;
    if (qh.enabled !== undefined) update.quietHoursEnabled = qh.enabled;
    if (qh.start !== undefined) update.quietHoursStart = qh.start;
    if (qh.end !== undefined) update.quietHoursEnd = qh.end;
    if (qh.days !== undefined) update.quietHoursDays = qh.days;
    if (qh.timezone !== undefined) update.quietHoursTimezone = qh.timezone;
  }

  return update;
}

/**
 * Quiet Hours has to end up with a window. Each field is independently optional
 * so a client can PATCH just the toggle, but the MERGED result must still have
 * both ends — otherwise the row reads "enabled" while the evaluator silently
 * does nothing and the UI shows a schedule the server never stored.
 */
function assertQuietHoursWindow(
  current: NonNullable<SettingsBundle["notificationSettings"]>,
  update: NotificationSettingsUpdate
): void {
  const enabled = update.quietHoursEnabled ?? current.quietHoursEnabled;
  if (!enabled) return;

  const start = update.quietHoursStart ?? current.quietHoursStart;
  const end = update.quietHoursEnd ?? current.quietHoursEnd;
  if (!start || !end) {
    throw new BadRequestError("USER_SETTINGS_INVALID_QUIET_HOURS");
  }
}

export const userSettingsService = {
  async getMySettings(userId: string): Promise<UserSettingsResponse> {
    const bundle = await loadSettingsBundle(userId);
    return mapSettingsBundle(bundle);
  },

  async listCallAllowedFriends(
    userId: string,
    params: { cursor?: string; limit: number }
  ) {
    await loadSettingsBundle(userId);
    return userSettingsRepository.listCallAllowedFriends(userId, params);
  },

  async addCallAllowedFriend(userId: string, friendId: string): Promise<void> {
    if (friendId === userId) {
      throw new BadRequestError("USER_SETTINGS_INVALID_CALL_ALLOW_LIST");
    }

    const count = await userSettingsRepository.countCallAllowedFriends(userId);
    if (count >= 500) {
      throw new ConflictError("CALL_ALLOW_LIST_FULL");
    }

    await userSettingsRepository.addCallAllowedFriend(userId, friendId);
    await this.broadcastSettings(userId);
  },

  async removeCallAllowedFriend(
    userId: string,
    friendId: string
  ): Promise<void> {
    await userSettingsRepository.removeCallAllowedFriend(userId, friendId);
    await this.broadcastSettings(userId);
  },

  /**
   * Re-read and push the current settings to the user's other devices. The
   * Selected-Friends allow-list is edited one friend at a time, so each
   * add/remove is its own authorization change and has to sync on its own.
   */
  async broadcastSettings(userId: string): Promise<void> {
    const bundle = await loadSettingsBundle(userId);
    emitSettingsUpdatedSafe(userId, mapSettingsBundle(bundle));
  },

  async updateMySettings(
    userId: string,
    input: UpdateSettingsInput
  ): Promise<UserSettingsResponse> {
    const current = await loadSettingsBundle(userId);

    const privacyUpdate = input.privacy;
    const callAllowedFriendIds = normalizeCallAllowedFriendIds(
      userId,
      privacyUpdate?.callAllowedFriendIds
    );

    let privacyFields: PrivacySettingsUpdate | undefined;
    if (privacyUpdate) {
      const { callAllowedFriendIds: _ignored, ...rest } = privacyUpdate;
      if (Object.keys(rest).length > 0) {
        privacyFields = rest;
      }
    }

    const notifications = input.notifications
      ? toNotificationUpdate(input.notifications)
      : undefined;

    if (notifications) {
      assertQuietHoursWindow(current.notificationSettings!, notifications);
    }

    await userSettingsRepository.updateSettings(userId, {
      privacy: privacyFields,
      chat: input.chat,
      app: input.app,
      notifications,
      liveStream: input.liveStream,
      callAllowedFriendIds,
    });

    const updated = await loadSettingsBundle(userId);
    const response = mapSettingsBundle(updated);

    // Let notifications-service bust its cached notification-settings entry.
    publishSettingsUpdatedSafe({
      userId,
      updatedAt: new Date().toISOString(),
    });

    // Push the full new state to this user's OTHER logged-in devices (web /
    // Android / iOS) so nothing has to poll or re-login to converge. Carries
    // the same DTO `GET /settings/me` returns, so a client can swap its cache
    // wholesale instead of patching field-by-field.
    emitSettingsUpdatedSafe(userId, response);

    return response;
  },
};

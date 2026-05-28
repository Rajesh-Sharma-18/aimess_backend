export type PrivacyScopeValue =
  | "EVERYONE"
  | "FRIENDS_OF_FRIENDS"
  | "FRIENDS"
  | "NO_ONE";

export type CallPrivacyScopeValue = "FRIENDS" | "SELECTED_FRIENDS" | "NO_ONE";

export type AutoDeleteTimerValue = "OFF" | "DAYS_7" | "DAYS_15" | "DAYS_30";

export type AppThemeValue = "LIGHT" | "DARK" | "AUTO";

export type LiveStreamQualityValue =
  | "AUTO"
  | "HIGH_1080P"
  | "STANDARD_720P"
  | "DATA_SAVER_480P";

export type UserPrivacySettings = {
  whoCanFindMe: PrivacyScopeValue;
  whoCanSendFriendRequests: PrivacyScopeValue;
  whoCanSeeOnlineStatus: PrivacyScopeValue;
  whoCanViewProfile: PrivacyScopeValue;
  whoCanCallMe: CallPrivacyScopeValue;
  /** User IDs allowed to call when `whoCanCallMe` is `SELECTED_FRIENDS`. */
  callAllowedFriendIds: string[];
};

export type UserChatSettings = {
  autoDeleteTimer: AutoDeleteTimerValue;
  typingIndicators: boolean;
  readReceipts: boolean;
};

export type UserAppSettings = {
  /** ISO 639-1; supported: en, vi, th. */
  language: string;
  /** `AUTO` is shown as "System" in the UI. */
  theme: AppThemeValue;
};

/** Notification Preferences screen — per-category toggles + Quiet Hours. */
export type UserNotificationSettings = {
  chat: boolean;
  call: boolean;
  friendRequest: boolean;
  system: boolean;
  community: boolean;
  liveStream: boolean;
  quietHours: {
    enabled: boolean;
    /** "HH:mm" 24h, or null when unset. */
    start: string | null;
    end: string | null;
    /** Days the quiet window applies to; 0=Sunday .. 6=Saturday. */
    days: number[];
  };
};

/** Livestream screen — default playback quality. */
export type UserLiveStreamSettings = {
  defaultVideoQuality: LiveStreamQualityValue;
};

/** GET/PATCH /settings/me */
export type UserSettingsResponse = {
  privacy: UserPrivacySettings;
  chat: UserChatSettings;
  app: UserAppSettings;
  notifications: UserNotificationSettings;
  liveStream: UserLiveStreamSettings;
  updatedAt: string;
};

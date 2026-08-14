export type PrivacyScopeValue =
  | "EVERYONE"
  | "FRIENDS_OF_FRIENDS"
  | "FRIENDS"
  | "NO_ONE";

/** `EVERYONE` is the only scope admitting a non-friend caller. */
export type CallPrivacyScopeValue =
  | "EVERYONE"
  | "FRIENDS"
  | "SELECTED_FRIENDS"
  | "NO_ONE";

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
  /** LEGACY enum, still returned for clients written against it. */
  autoDeleteTimer: AutoDeleteTimerValue;
  /**
   * CANONICAL "Default message timer for new private chats". Snapshotted into
   * a private room when it is created; never rewrites existing rooms, and
   * never applies to groups (a group timer is an admin/moderator room
   * decision). `version` is 0 until the user saves it once, which is how the
   * dual-read in chat-service knows to fall back to `autoDeleteTimer`.
   */
  autoDeleteDefault: {
    mode: "OFF" | "TIMER";
    ttlSeconds: number | null;
    version: number;
  };
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
  /** false hides message content in the push banner (lock-screen privacy). */
  showPreview: boolean;
  quietHours: {
    enabled: boolean;
    /** "HH:mm" 24h, or null when unset. */
    start: string | null;
    end: string | null;
    /** Days the quiet window applies to; 0=Sunday .. 6=Saturday. */
    days: number[];
    /**
     * IANA zone the window is evaluated in ("Asia/Bangkok"), or null to use
     * server-local time. Clients should send their own resolved zone.
     */
    timezone: string | null;
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

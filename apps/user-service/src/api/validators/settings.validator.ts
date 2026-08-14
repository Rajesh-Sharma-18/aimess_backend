import { z } from "zod";

// Privacy scope option sets follow the exact choices shown per screen in Figma.
const findMeScopeSchema = z.enum(["EVERYONE", "FRIENDS_OF_FRIENDS", "NO_ONE"]);
const friendRequestScopeSchema = z.enum([
  "EVERYONE",
  "FRIENDS_OF_FRIENDS",
  "NO_ONE",
]);
const onlineStatusScopeSchema = z.enum(["EVERYONE", "FRIENDS", "NO_ONE"]);
const viewProfileScopeSchema = z.enum([
  "EVERYONE",
  "FRIENDS_OF_FRIENDS",
  "FRIENDS",
  "NO_ONE",
]);
const callPrivacyScopeSchema = z.enum([
  "EVERYONE",
  "FRIENDS",
  "SELECTED_FRIENDS",
  "NO_ONE",
]);

const autoDeleteTimerSchema = z.enum(["OFF", "DAYS_7", "DAYS_15", "DAYS_30"]);

const appThemeSchema = z.enum(["LIGHT", "DARK", "AUTO"]);

// Supported app languages (General → Select Language).
const languageSchema = z.enum(["en", "vi", "th"]);

const liveStreamQualitySchema = z.enum([
  "AUTO",
  "HIGH_1080P",
  "STANDARD_720P",
  "DATA_SAVER_480P",
]);

const uuidSchema = z.string().uuid("User ID is invalid");

// "HH:mm" 24-hour clock, e.g. "22:00".
const timeOfDaySchema = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):[0-5]\d$/,
    "Time must be in HH:mm 24-hour format (e.g. 22:00)"
  );

// 0 = Sunday .. 6 = Saturday. This numbering is the canon — the DB column, the
// gRPC contract, the notifications-service evaluator and every client agree on
// it, so do not renumber one layer in isolation.
const dayOfWeekSchema = z.number().int().min(0).max(6);

/**
 * An IANA timezone id. Validated by asking Intl to build a formatter for it,
 * which is the only authoritative list available and needs no dependency —
 * `Intl.supportedValuesOf` misses aliases like "Asia/Calcutta" that browsers
 * still resolve to. `null` clears it back to server-local evaluation.
 */
const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Timezone must be a valid IANA zone id (e.g. Asia/Bangkok)");

const updatePrivacySettingsSchema = z
  .object({
    whoCanFindMe: findMeScopeSchema.optional(),
    whoCanSendFriendRequests: friendRequestScopeSchema.optional(),
    whoCanSeeOnlineStatus: onlineStatusScopeSchema.optional(),
    whoCanViewProfile: viewProfileScopeSchema.optional(),
    whoCanCallMe: callPrivacyScopeSchema.optional(),
    callAllowedFriendIds: z.array(uuidSchema).max(500).optional(),
  })
  .strict();

const updateChatSettingsSchema = z
  .object({
    autoDeleteTimer: autoDeleteTimerSchema.optional(),
    typingIndicators: z.boolean().optional(),
    readReceipts: z.boolean().optional(),
  })
  .strict();

const updateAppSettingsSchema = z
  .object({
    language: languageSchema.optional(),
    theme: appThemeSchema.optional(),
  })
  .strict();

const updateQuietHoursSchema = z
  .object({
    enabled: z.boolean().optional(),
    start: timeOfDaySchema.optional(),
    end: timeOfDaySchema.optional(),
    days: z
      .array(dayOfWeekSchema)
      .max(7)
      .transform((days) => [...new Set(days)])
      .optional(),
    timezone: timezoneSchema.nullable().optional(),
  })
  .strict();

const updateNotificationSettingsSchema = z
  .object({
    chat: z.boolean().optional(),
    call: z.boolean().optional(),
    friendRequest: z.boolean().optional(),
    system: z.boolean().optional(),
    community: z.boolean().optional(),
    liveStream: z.boolean().optional(),
    showPreview: z.boolean().optional(),
    quietHours: updateQuietHoursSchema.optional(),
  })
  .strict();

const updateLiveStreamSettingsSchema = z
  .object({
    defaultVideoQuality: liveStreamQualitySchema.optional(),
  })
  .strict();

function hasAtLeastOneKey(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

export const updateSettingsSchema = z
  .object({
    privacy: updatePrivacySettingsSchema.optional(),
    chat: updateChatSettingsSchema.optional(),
    app: updateAppSettingsSchema.optional(),
    notifications: updateNotificationSettingsSchema.optional(),
    liveStream: updateLiveStreamSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.privacy !== undefined ||
      body.chat !== undefined ||
      body.app !== undefined ||
      body.notifications !== undefined ||
      body.liveStream !== undefined,
    { message: "At least one settings group is required to update" }
  )
  .refine((body) => !body.privacy || hasAtLeastOneKey(body.privacy), {
    message: "Privacy settings must include at least one field",
    path: ["privacy"],
  })
  .refine((body) => !body.chat || hasAtLeastOneKey(body.chat), {
    message: "Chat settings must include at least one field",
    path: ["chat"],
  })
  .refine((body) => !body.app || hasAtLeastOneKey(body.app), {
    message: "App settings must include at least one field",
    path: ["app"],
  })
  .refine(
    (body) => !body.notifications || hasAtLeastOneKey(body.notifications),
    {
      message: "Notification settings must include at least one field",
      path: ["notifications"],
    }
  )
  .refine((body) => !body.liveStream || hasAtLeastOneKey(body.liveStream), {
    message: "Livestream settings must include at least one field",
    path: ["liveStream"],
  });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const friendIdParamSchema = z.object({ friendId: uuidSchema });
export type FriendIdParam = z.infer<typeof friendIdParamSchema>;

export const listCallAllowedFriendsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});
export type ListCallAllowedFriendsQuery = z.infer<
  typeof listCallAllowedFriendsQuerySchema
>;

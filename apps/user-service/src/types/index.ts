/** HTTP payloads, DTOs, and shared typing for this service. */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};

export type { ConnectedAccountsResponse } from "./connected-accounts.types.js";
export type { UserProfileData } from "./user-profile.types.js";
export type { UserSettingsResponse } from "./user-settings.types.js";

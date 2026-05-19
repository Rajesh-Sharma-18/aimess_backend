/** HTTP payloads, DTOs, and shared typing for this service. */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};

export type { UserProfileResponse } from "./user-profile.types.js";

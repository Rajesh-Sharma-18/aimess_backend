import type { ProfileGenderValue } from "../lib/profile-fields.util.js";
import type {
  AccountLoadStatus,
  AuthAccountSummary,
} from "./auth-account.types.js";

/** Profile fields returned by GET/PATCH /profiles/me (PATCH omits `account`). */
export type UserProfileData = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: string;
  gender: ProfileGenderValue | null;
  /** Presigned GET URL (private bucket). Refresh via profile API when expired. */
  avatarUrl: string | null;
  /** Seconds until `avatarUrl` expires; null if no avatar. */
  avatarUrlExpiresIn: number | null;
  updatedAt: string;
};

/** GET /profiles/me — profile plus connected sign-in providers. */
export type UserProfileResponse = UserProfileData & {
  /** Null when auth-service is down and no cached copy exists. */
  account: AuthAccountSummary | null;
  /** `live` = fresh from auth; `cached` = auth down, stale copy; `unavailable` = auth down, no cache. */
  accountStatus: AccountLoadStatus;
};

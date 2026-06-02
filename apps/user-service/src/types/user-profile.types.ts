import type { ProfileGenderValue } from "../lib/profile-fields.util.js";

/** Profile fields returned by GET/PATCH /profiles/me. */
export type UserProfileData = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  /** Primary auth/login account from auth-service; null if unavailable. */
  account: string | null;
  /** Primary account email from auth-service; null if unset or auth unavailable. */
  email: string | null;
  /** True when a GOOGLE provider is linked in auth-service. */
  isGoogleLogin: boolean;
  /** True when an APPLE provider is linked in auth-service. */
  isAppleLogin: boolean;
  dateOfBirth: string;
  gender: ProfileGenderValue | null;
  /** Presigned GET URL (private bucket). Refresh via profile API when expired. */
  avatarUrl: string | null;
  /** Seconds until `avatarUrl` expires; null if no avatar. */
  avatarUrlExpiresIn: number | null;
  updatedAt: string;
};

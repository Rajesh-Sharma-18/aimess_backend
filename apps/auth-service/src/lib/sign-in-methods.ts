import { AuthProvider } from "../generated/prisma/client.js";
import type { ActiveAuthUser } from "./account-guard.js";

export type SocialLinkProvider =
  | typeof AuthProvider.GOOGLE
  | typeof AuthProvider.APPLE;

export function countSignInMethods(
  user: ActiveAuthUser,
  linkedProviderCount: number
): number {
  return (user.passwordHash ? 1 : 0) + linkedProviderCount;
}

export function toSocialAuthProvider(
  provider: SocialLinkProvider
): "GOOGLE" | "APPLE" {
  return provider === AuthProvider.GOOGLE ? "GOOGLE" : "APPLE";
}

/**
 * The error code that tells a PASSWORD-LESS account how it signs in instead.
 *
 * Callers must have established that password authentication is unavailable
 * (`passwordHash === null`) BEFORE asking. Being linked to Google or Apple is
 * not on its own a reason to refuse a password: an account that set one (at
 * signup, through Forgot Password, or later) and linked a provider legitimately
 * supports both, and redirecting it would lock the user out of a credential
 * that works.
 *
 * The answer is the set of providers linked NOW, not how the account was
 * founded: with both Google and Apple linked either one works, so the neutral
 * code names both rather than picking one.
 */
export function passwordUnavailableCode(user: {
  linkedAccounts: readonly { provider: AuthProvider }[];
}):
  | "AUTH_GOOGLE_LOGIN_REQUIRED"
  | "AUTH_APPLE_LOGIN_REQUIRED"
  | "AUTH_SOCIAL_LOGIN_REQUIRED"
  | "AUTH_PASSWORD_NOT_SET" {
  const linked = new Set(user.linkedAccounts.map((link) => link.provider));
  const google = linked.has(AuthProvider.GOOGLE);
  const apple = linked.has(AuthProvider.APPLE);
  if (google && apple) return "AUTH_SOCIAL_LOGIN_REQUIRED";
  if (google) return "AUTH_GOOGLE_LOGIN_REQUIRED";
  if (apple) return "AUTH_APPLE_LOGIN_REQUIRED";
  return "AUTH_PASSWORD_NOT_SET";
}

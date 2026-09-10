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
 * The provider a PASSWORD-LESS account has to sign in with, or null when it
 * has no social link to point at.
 *
 * Callers must have established that password authentication is unavailable
 * (`passwordHash === null`) BEFORE asking. Being linked to Google or Apple is
 * not on its own a reason to refuse a password: an account that set one and
 * later linked a provider legitimately supports both, and redirecting it to the
 * provider would lock the user out of a credential that works.
 *
 * `primaryAccount` decides when it names a provider that is actually linked —
 * it records the first sign-in method and is never overwritten, so it is the
 * closest thing to a "this is how you get in" field. It can be EMAIL (an
 * OTP-linked address) or stale/null on older rows, hence the fallback to the
 * oldest link, which is the identity that founded the account.
 */
export function resolveRequiredSocialProvider(user: {
  primaryAccount: AuthProvider | null;
  linkedAccounts: readonly { provider: AuthProvider }[];
}): SocialLinkProvider | null {
  const social = user.linkedAccounts.filter(
    (link): link is { provider: SocialLinkProvider } =>
      link.provider === AuthProvider.GOOGLE ||
      link.provider === AuthProvider.APPLE
  );
  if (social.length === 0) return null;

  const primaryIsLinked = social.some(
    (link) => link.provider === user.primaryAccount
  );
  if (primaryIsLinked) return user.primaryAccount as SocialLinkProvider;

  return social[0].provider;
}

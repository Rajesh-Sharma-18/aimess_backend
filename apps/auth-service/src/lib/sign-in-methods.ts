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

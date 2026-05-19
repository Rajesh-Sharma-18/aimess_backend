import { BadRequestError, ConflictError } from "@aimess/errors";

import type {
  LinkAppleInput,
  LinkGoogleInput,
  UnlinkSocialInput,
} from "../api/validators/social-link.validator.js";
import { AuthProvider } from "../generated/prisma/client.js";
import { verifyAppleIdentityToken } from "../lib/apple-identity-token.js";
import { verifyGoogleIdToken } from "../lib/google-id-token.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import {
  countSignInMethods,
  toSocialAuthProvider,
  type SocialLinkProvider,
} from "../lib/sign-in-methods.js";
import { linkedAccountRepository } from "../repositories/linked-account.repository.js";

export type SocialLinkResult = {
  provider: "GOOGLE" | "APPLE";
};

async function linkProvider(
  userId: string,
  provider: SocialLinkProvider,
  profile: {
    sub: string;
    email: string | null;
    displayName: string | null;
  }
): Promise<SocialLinkResult> {
  await loadActiveAuthUser(userId);

  const socialProvider = toSocialAuthProvider(provider);

  const existingByProviderUser = await linkedAccountRepository.findByProvider(
    provider,
    profile.sub
  );
  if (existingByProviderUser) {
    if (existingByProviderUser.userId === userId) {
      throw new BadRequestError("AUTH_SOCIAL_ALREADY_LINKED");
    }
    throw new ConflictError("AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE");
  }

  const existingForUser = await linkedAccountRepository.findByUserIdAndProvider(
    userId,
    provider
  );
  if (existingForUser) {
    throw new BadRequestError("AUTH_PROVIDER_ALREADY_LINKED");
  }

  await linkedAccountRepository.create({
    userId,
    provider,
    providerUserId: profile.sub,
    email: profile.email,
    displayName: profile.displayName,
  });

  return { provider: socialProvider };
}

async function unlinkProvider(
  userId: string,
  provider: SocialLinkProvider
): Promise<SocialLinkResult> {
  const user = await loadActiveAuthUser(userId);
  const socialProvider = toSocialAuthProvider(provider);

  const link = await linkedAccountRepository.findByUserIdAndProvider(
    userId,
    provider
  );
  if (!link) {
    throw new BadRequestError("AUTH_SOCIAL_NOT_LINKED");
  }

  const linkedCount = await linkedAccountRepository.countByUserId(userId);
  const signInMethods = countSignInMethods(user, linkedCount);
  if (signInMethods <= 1) {
    throw new BadRequestError("AUTH_LAST_SIGN_IN_METHOD");
  }

  await linkedAccountRepository.deleteByUserIdAndProvider(userId, provider);

  return { provider: socialProvider };
}

export const socialLinkService = {
  async linkGoogle(
    userId: string,
    input: LinkGoogleInput
  ): Promise<SocialLinkResult> {
    const profile = await verifyGoogleIdToken(input.idToken);

    return linkProvider(userId, AuthProvider.GOOGLE, {
      sub: profile.sub,
      email: profile.email,
      displayName: profile.displayName,
    });
  },

  async linkApple(
    userId: string,
    input: LinkAppleInput
  ): Promise<SocialLinkResult> {
    const tokenProfile = await verifyAppleIdentityToken(input.identityToken);

    const email =
      tokenProfile.email ?? input.email?.trim().toLowerCase() ?? null;

    return linkProvider(userId, AuthProvider.APPLE, {
      sub: tokenProfile.sub,
      email,
      displayName: input.fullName?.trim() ?? null,
    });
  },

  async unlink(
    userId: string,
    input: UnlinkSocialInput
  ): Promise<SocialLinkResult> {
    const provider =
      input.provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;

    return unlinkProvider(userId, provider);
  },
};

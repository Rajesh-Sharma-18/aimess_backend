import { BadRequestError, ConflictError } from "@aimess/errors";

import type {
  LinkAppleInput,
  LinkGoogleInput,
  UnlinkSocialInput,
} from "../api/validators/social-link.validator.js";
import { AuthProvider, Prisma } from "../generated/prisma/client.js";
import { verifyAppleIdToken } from "../lib/apple-id-token.js";
import { verifyGoogleIdToken } from "../lib/google-id-token.js";

function isUniqueConstraintError(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Was the unique violation on the (provider, providerUserId) index? */
function isProviderAccountConflict(
  error: Prisma.PrismaClientKnownRequestError
): boolean {
  const target = error.meta?.target;
  return JSON.stringify(target ?? "").includes("providerUserId");
}
import { loadActiveAuthUser } from "../lib/account-guard.js";
import {
  countSignInMethods,
  toSocialAuthProvider,
  type SocialLinkProvider,
} from "../lib/sign-in-methods.js";
import { authRepository } from "../repositories/auth.repository.js";
import { linkedAccountRepository } from "../repositories/linked-account.repository.js";

export type SocialLinkResult = {
  provider: "GOOGLE" | "APPLE";
  primaryAccount: AuthProvider | null;
};

export type SocialUnlinkResult = {
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

  try {
    await linkedAccountRepository.create({
      userId,
      provider,
      providerUserId: profile.sub,
      email: profile.email,
      displayName: profile.displayName,
    });
  } catch (error) {
    // A concurrent link request won the race between the checks above and this
    // insert; the unique constraint is the source of truth.
    if (isUniqueConstraintError(error)) {
      if (isProviderAccountConflict(error)) {
        throw new ConflictError("AUTH_SOCIAL_ACCOUNT_LINKED_ELSEWHERE");
      }
      throw new BadRequestError("AUTH_PROVIDER_ALREADY_LINKED");
    }
    throw error;
  }

  // First linked method wins: only sets this provider when primaryAccount is null.
  const primaryAccount = await authRepository.setPrimaryAccountIfUnset(
    userId,
    provider
  );

  return { provider: socialProvider, primaryAccount };
}

async function unlinkProvider(
  userId: string,
  provider: SocialLinkProvider
): Promise<SocialUnlinkResult> {
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
    const tokenProfile = await verifyAppleIdToken(input.identityToken);

    const email =
      tokenProfile.email ?? input.email?.trim().toLowerCase() ?? null;

    return linkProvider(userId, AuthProvider.APPLE, {
      sub: tokenProfile.sub,
      email,
      displayName: tokenProfile.displayName ?? input.fullName?.trim() ?? null,
    });
  },

  async unlink(
    userId: string,
    input: UnlinkSocialInput
  ): Promise<SocialUnlinkResult> {
    const provider =
      input.provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;

    return unlinkProvider(userId, provider);
  },
};

import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";

import { AccountStatus, AuthProvider } from "../generated/prisma/client.js";
import { verifyAppleIdentityToken } from "../lib/apple-identity-token.js";
import { verifyGoogleIdToken } from "../lib/google-id-token.js";
import {
  buildSocialAccountBase,
  generateUniqueAccount,
} from "../lib/social-account.util.js";
import { buildSessionContext } from "../lib/session-context.js";
import { issueAuthTokens } from "../lib/token.js";
import { publishUserCreatedSafe } from "../messaging/publish-user-created.js";
import { authRepository } from "../repositories/auth.repository.js";
import { linkedAccountRepository } from "../repositories/linked-account.repository.js";
import type {
  AppleLoginInput,
  GoogleLoginInput,
  SocialAuthProvider,
  SocialLoginResult,
} from "../types/index.js";

type AuthUserRow = {
  id: string;
  account: string;
  email: string | null;
  status: AccountStatus;
  lockedUntil: Date | null;
  deletedAt: Date | null;
};

function assertUserCanLogin(user: AuthUserRow): void {
  if (user.deletedAt) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UnauthorizedError("AUTH_ACCOUNT_LOCKED");
  }

  if (user.status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }
}

async function issueTokensForUser(
  req: Request,
  user: AuthUserRow
): Promise<SocialLoginResult["tokens"]> {
  await authRepository.recordSuccessfulLogin(user.id);
  const session = buildSessionContext(req);
  return issueAuthTokens(user.id, session);
}

async function signInWithProvider(
  req: Request,
  provider: SocialAuthProvider,
  profile: {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
  }
): Promise<SocialLoginResult> {
  const authProvider =
    provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;

  const existingLink = await linkedAccountRepository.findByProvider(
    authProvider,
    profile.sub
  );

  if (existingLink?.user) {
    assertUserCanLogin(existingLink.user);
    const tokens = await issueTokensForUser(req, existingLink.user);

    return {
      isNewUser: false,
      user: {
        userId: existingLink.user.id,
        account: existingLink.user.account,
        email: existingLink.user.email,
        provider,
      },
      tokens,
    };
  }

  if (profile.email) {
    const existingUser = await authRepository.findByEmail(profile.email);
    if (existingUser) {
      assertUserCanLogin(existingUser);

      const alreadyLinked = await linkedAccountRepository.findByProvider(
        authProvider,
        profile.sub
      );
      if (!alreadyLinked) {
        await linkedAccountRepository.create({
          userId: existingUser.id,
          provider: authProvider,
          providerUserId: profile.sub,
          email: profile.email,
          displayName: profile.displayName,
        });
      }

      const tokens = await issueTokensForUser(req, existingUser);

      return {
        isNewUser: false,
        user: {
          userId: existingUser.id,
          account: existingUser.account,
          email: existingUser.email,
          provider,
        },
        tokens,
      };
    }
  }

  if (!profile.email) {
    throw new ConflictError("AUTH_SOCIAL_EMAIL_REQUIRED");
  }

  const accountBase = buildSocialAccountBase(
    provider === "GOOGLE" ? "google" : "apple",
    profile.sub,
    profile.email
  );
  const account = await generateUniqueAccount(accountBase);

  const user = await authRepository.createUserWithLinkedAccount({
    account,
    email: profile.email,
    emailVerified: profile.emailVerified,
    provider: authProvider,
    providerUserId: profile.sub,
    displayName: profile.displayName,
    providerEmail: profile.email,
  });

  publishUserCreatedSafe({
    userId: user.id,
    account: user.account,
    email: user.email ?? profile.email,
    createdAt: user.createdAt.toISOString(),
  });

  const session = buildSessionContext(req);
  const tokens = await issueAuthTokens(user.id, session);

  return {
    isNewUser: true,
    user: {
      userId: user.id,
      account: user.account,
      email: user.email,
      provider,
    },
    tokens,
  };
}

export const socialAuthService = {
  async loginWithGoogle(
    req: Request,
    input: GoogleLoginInput
  ): Promise<SocialLoginResult> {
    const profile = await verifyGoogleIdToken(input.idToken);

    return signInWithProvider(req, "GOOGLE", {
      sub: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.displayName,
    });
  },

  async loginWithApple(
    req: Request,
    input: AppleLoginInput
  ): Promise<SocialLoginResult> {
    const tokenProfile = await verifyAppleIdentityToken(input.identityToken);

    const email =
      tokenProfile.email ?? input.email?.trim().toLowerCase() ?? null;
    const emailVerified = tokenProfile.email
      ? tokenProfile.emailVerified
      : Boolean(input.email);

    return signInWithProvider(req, "APPLE", {
      sub: tokenProfile.sub,
      email,
      emailVerified,
      displayName: input.fullName?.trim() ?? null,
    });
  },
};

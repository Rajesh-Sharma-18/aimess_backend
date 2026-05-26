import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";

import {
  AccountStatus,
  AuthProvider,
  Prisma,
} from "../generated/prisma/client.js";
import { verifyAppleIdToken } from "../lib/apple-id-token.js";
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

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

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
  const { tokens } = await issueAuthTokens(user.id, session);
  return tokens;
}

async function loginExistingLinkedUser(
  req: Request,
  provider: SocialAuthProvider,
  user: AuthUserRow
): Promise<SocialLoginResult> {
  assertUserCanLogin(user);
  const tokens = await issueTokensForUser(req, user);

  return {
    isNewUser: false,
    user: {
      userId: user.id,
      account: user.account,
      email: user.email,
      provider,
    },
    tokens,
  };
}

async function signInWithProvider(
  req: Request,
  provider: SocialAuthProvider,
  profile: {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
  },
  fcmTokens: string[] = []
): Promise<SocialLoginResult> {
  const authProvider =
    provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;

  const existingLink = await linkedAccountRepository.findByProvider(
    authProvider,
    profile.sub
  );

  if (existingLink?.user) {
    await authRepository.mergeFcmTokens(existingLink.user.id, fcmTokens);
    return loginExistingLinkedUser(req, provider, existingLink.user);
  }

  // Auto-link to an existing account by email ONLY when the email was verified
  // by the provider's cryptographically-signed token. A client-supplied or
  // unverified email must never merge into an existing account (takeover risk).
  if (profile.email && profile.emailVerified) {
    const existingUser = await authRepository.findByEmail(profile.email);
    if (existingUser) {
      assertUserCanLogin(existingUser);

      // Rely on the unique constraint instead of a redundant pre-check: a
      // concurrent login may create the same link, which surfaces as P2002.
      try {
        await linkedAccountRepository.create({
          userId: existingUser.id,
          provider: authProvider,
          providerUserId: profile.sub,
          email: profile.email,
          displayName: profile.displayName,
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
      }

      await authRepository.mergeFcmTokens(existingUser.id, fcmTokens);
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
  const { tokens } = await issueAuthTokens(user.id, session);

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

    return signInWithProvider(
      req,
      "GOOGLE",
      {
        sub: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName,
      },
      input.fcmTokens
    );
  },

  async loginWithApple(
    req: Request,
    input: AppleLoginInput
  ): Promise<SocialLoginResult> {
    const tokenProfile = await verifyAppleIdToken(input.identityToken);

    // Only the email from the verified Apple token may be trusted as verified.
    // A client-supplied `input.email` is never treated as verified (prevents
    // account-takeover by claiming someone else's email).
    const email =
      tokenProfile.email ?? input.email?.trim().toLowerCase() ?? null;
    const emailVerified = tokenProfile.email
      ? tokenProfile.emailVerified
      : false;

    return signInWithProvider(
      req,
      "APPLE",
      {
        sub: tokenProfile.sub,
        email,
        emailVerified,
        displayName: tokenProfile.displayName ?? input.fullName?.trim() ?? null,
      },
      input.fcmTokens
    );
  },
};

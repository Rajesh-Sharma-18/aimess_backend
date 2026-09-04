import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import {
  AccountStatus,
  AuthProvider,
  GlobalRole,
  Prisma,
} from "../generated/prisma/client.js";
import { verifyAppleIdToken } from "../lib/apple-id-token.js";
import { verifyGoogleIdToken } from "../lib/google-id-token.js";
import {
  buildSocialAccountBase,
  generateUniqueAccount,
} from "../lib/social-account.util.js";
import { resolveSocialProfileName } from "../lib/social-profile-name.js";
import { assertNotBanned } from "../lib/account-guard.js";
import { assertEmailAvailable } from "../lib/email-availability.js";
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
  role: GlobalRole;
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

  // Google and Apple sign-in both funnel through here, so a banned account is
  // rejected on the social paths exactly as on password login.
  assertNotBanned(user.status);

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
  const { tokens } = await issueAuthTokens(
    user.id,
    user.role === "ADMIN" ? "ADMIN" : "USER",
    session
  );
  return tokens;
}

async function loginExistingLinkedUser(
  req: Request,
  provider: SocialAuthProvider,
  user: AuthUserRow
): Promise<SocialLoginResult> {
  assertUserCanLogin(user);
  const tokens = await issueTokensForUser(req, user);
  const isProfileCompleted = await authRepository.getProfileCompleted(user.id);

  return {
    isNewUser: false,
    user: {
      userId: user.id,
      account: user.account,
      email: user.email,
      provider,
    },
    isProfileCompleted,
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
    /** Verified provider given name; null when the provider sent none. */
    firstName: string | null;
    /** Verified provider family name; null when the provider sent none. */
    lastName: string | null;
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
        isProfileCompleted: existingUser.isProfileCompleted,
        tokens,
      };
    }
  }

  if (!profile.email) {
    throw new ConflictError("AUTH_SOCIAL_EMAIL_REQUIRED");
  }

  // Sign-UP, not sign-in: no AuthUser owns this address yet, so a brand-new
  // account is about to claim it. An admin account in backoffice's admin_db may
  // already hold it — the auto-link branch above never sees that database, and
  // no index spans the two. Existing users keep signing in through the branches
  // above; only creating a NEW account on an admin's email is refused.
  await assertEmailAvailable(profile.email);

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

  // Provider names ride the creation event so user-service seeds the profile
  // with them instead of the placeholder "<account> User". Undefined (not "")
  // when the provider gave nothing — the consumer keeps its own fallback.
  publishUserCreatedSafe({
    userId: user.id,
    account: user.account,
    email: user.email ?? profile.email,
    createdAt: user.createdAt.toISOString(),
    isGoogleLogin: authProvider === AuthProvider.GOOGLE,
    firstName: profile.firstName ?? undefined,
    lastName: profile.lastName ?? undefined,
  });

  const session = buildSessionContext(req);

  // Same audit row password registration emits — without this the audit log shows a
  // login for a user it never saw being created.
  publishAdminActivitySafe({
    actorId: user.id,
    action: USER_AUDIT_ACTIONS.USER_REGISTERED,
    targetType: "user",
    targetId: user.id,
    after: { account: user.account, provider },
    ip: session.ipAddress,
    userAgent: session.userAgent,
  });

  // Brand-new account — always the default non-privileged role.
  const { tokens } = await issueAuthTokens(user.id, "USER", session);

  return {
    isNewUser: true,
    user: {
      userId: user.id,
      account: user.account,
      email: user.email,
      provider,
    },
    // Brand-new account — profile is never complete at creation.
    isProfileCompleted: false,
    tokens,
  };
}

export const socialAuthService = {
  async loginWithGoogle(
    req: Request,
    input: GoogleLoginInput
  ): Promise<SocialLoginResult> {
    const profile = await verifyGoogleIdToken(input.idToken);

    // `picture` is deliberately not persisted: user_profiles.avatarUrl stores a
    // MinIO object key in the private avatars bucket, so a Google CDN URL there
    // resolves to nothing. Importing it would need a server-side fetch + upload.
    // ponytail: no social-avatar import; add an ingest step in avatar.service if
    // product wants Google pictures pulled in.
    return signInWithProvider(
      req,
      "GOOGLE",
      {
        sub: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName,
        firstName: profile.firstName,
        lastName: profile.lastName,
      },
      input.fcmTokens
    );
  },

  async loginWithApple(
    req: Request,
    input: AppleLoginInput
  ): Promise<SocialLoginResult> {
    const tokenProfile = await verifyAppleIdToken(input.identityToken);

    // ONLY the email Apple asserted in the signed identity token is used, and
    // `input.email` is ignored outright.
    //
    // It used to fall back to the request body when the token carried no email
    // — which is every Apple sign-in after the first. The value was marked
    // unverified, so it could not auto-link to an existing account, but it
    // still flowed into the sign-UP branch and was written to `AuthUser.email`.
    // That is account pre-hijacking: an attacker signs in with their own Apple
    // id while claiming victim@example.com, and a real account is created
    // holding the victim's address. When the victim later signs in with Google,
    // the by-email auto-link finds the squatted account and merges the victim's
    // identity into it — both parties then sign into one account, and the
    // attacker reads the victim's messages, communities and profile.
    //
    // With the fallback gone, an Apple sign-in that carries no email and has no
    // existing linked account is refused with AUTH_SOCIAL_EMAIL_REQUIRED rather
    // than inventing an identity. A genuine first-time sign-up is unaffected:
    // Apple always includes the email in that first identity token.
    const email = tokenProfile.email ?? null;
    const emailVerified = tokenProfile.email
      ? tokenProfile.emailVerified
      : false;

    // Apple hands the name over ONCE — in the first authorization response, not
    // in the identity token, and never again on later sign-ins. It is only ever
    // used to seed a brand-new profile below (signInWithProvider publishes it on
    // creation only), so a later login sending nulls cannot erase what was
    // stored on day one.
    const { firstName, lastName, displayName } = resolveSocialProfileName(
      typeof input.fullName === "string"
        ? { fullName: input.fullName }
        : {
            givenName: input.fullName?.givenName,
            familyName: input.fullName?.familyName,
          }
    );

    return signInWithProvider(
      req,
      "APPLE",
      {
        sub: tokenProfile.sub,
        email,
        emailVerified,
        displayName: tokenProfile.displayName ?? displayName,
        firstName,
        lastName,
      },
      input.fcmTokens
    );
  },
};

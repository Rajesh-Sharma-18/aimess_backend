import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import { isProfileComplete } from "@aimess/utils";

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
import { assertNotBanned, assertNotDeleted } from "../lib/account-guard.js";
import { assertEmailAvailable } from "../lib/email-availability.js";
import { buildSessionContext } from "../lib/session-context.js";
import type { DeviceInfoInput } from "../api/validators/device-info.validator.js";
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
  // The provider's signed token is the proven credential here, so naming the
  // deleted state leaks nothing: only whoever controls that Google/Apple
  // identity ever reaches this line.
  assertNotDeleted(user.deletedAt);

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
  user: AuthUserRow,
  device: DeviceInfoInput | null | undefined
): Promise<SocialLoginResult["tokens"]> {
  await authRepository.recordSuccessfulLogin(user.id);
  const session = buildSessionContext(req, device);
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
  user: AuthUserRow,
  device: DeviceInfoInput | null | undefined
): Promise<SocialLoginResult> {
  assertUserCanLogin(user);

  // Backfill, not a switch. Accounts created by a social sign-in before
  // primaryAccount was stamped at creation still carry null, and this is the
  // flow that knows which provider founded them. setPrimaryAccountIfUnset is a
  // no-op the moment a value exists, so a repeat sign-in — or an account that
  // has since linked an email by hand — is never overwritten.
  await authRepository.setPrimaryAccountIfUnset(
    user.id,
    provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE
  );

  const tokens = await issueTokensForUser(req, user, device);
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

/**
 * The account an incoming, provider-VERIFIED address already belongs to.
 *
 * Two places can hold that address and they mean different things:
 *
 *   - `AuthUser.email` — the PROFILE email, set only by the OTP-verified
 *     link-email flow. Matching it is what lets a user who linked
 *     name@example.com by hand then sign in with the Google account on that
 *     same address and land on their existing account.
 *   - `LinkedAccount.email` — the address a provider reported. Since a social
 *     sign-in no longer copies its address into the profile field, this is the
 *     ONLY record of it, so an account founded by Google must be findable here
 *     when the same person later arrives via Apple. Without this lookup that
 *     second provider would create a duplicate account.
 *
 * Both sides are verified: the caller has already checked the incoming token's
 * `email_verified`, and the link lookup filters on its own `emailVerified` so
 * a client-supplied address can never resolve to somebody else's account.
 */
async function findAccountForVerifiedProviderEmail(
  email: string
): Promise<AuthUserRow | null> {
  const byProfileEmail = await authRepository.findByEmail(email);
  if (byProfileEmail) {
    return byProfileEmail;
  }

  const byProviderEmail =
    await linkedAccountRepository.findUserByVerifiedProviderEmail(email);
  return byProviderEmail?.user ?? null;
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
  fcmTokens: string[] = [],
  device?: DeviceInfoInput | null
): Promise<SocialLoginResult> {
  const authProvider =
    provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;

  const existingLink = await linkedAccountRepository.findByProvider(
    authProvider,
    profile.sub
  );

  if (existingLink?.user) {
    await authRepository.mergeFcmTokens(existingLink.user.id, fcmTokens);
    return loginExistingLinkedUser(req, provider, existingLink.user, device);
  }

  // Which account, if any, already owns this address? Asked once and reused by
  // both the auto-link branch and the sign-up guard below, which need the same
  // answer for opposite reasons.
  const existingUser = profile.email
    ? await findAccountForVerifiedProviderEmail(profile.email)
    : null;

  // Auto-link to that account ONLY when the email was verified by the
  // provider's cryptographically-signed token. A client-supplied or unverified
  // email must never merge into an existing account (takeover risk).
  if (profile.email && profile.emailVerified) {
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
          // The token asserted it — the `profile.emailVerified` guard on this
          // branch is exactly that proof — so this link may later resolve a
          // sign-in from the OTHER provider on the same address.
          emailVerified: true,
          displayName: profile.displayName,
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
      }

      // The account existed before this provider did, so whatever founded it
      // keeps the primary slot; this only fills a slot that was never set.
      await authRepository.setPrimaryAccountIfUnset(
        existingUser.id,
        authProvider
      );

      await authRepository.mergeFcmTokens(existingUser.id, fcmTokens);
      const tokens = await issueTokensForUser(req, existingUser, device);
      const isProfileCompleted = await authRepository.getProfileCompleted(
        existingUser.id
      );

      return {
        isNewUser: false,
        user: {
          userId: existingUser.id,
          account: existingUser.account,
          // The PROFILE email, which for a Google/Apple-created account is
          // null. The provider's own address is never substituted here.
          email: existingUser.email,
          provider,
        },
        isProfileCompleted,
        tokens,
      };
    }
  }

  if (!profile.email) {
    throw new ConflictError("AUTH_SOCIAL_EMAIL_REQUIRED");
  }

  // Sign-UP, not sign-in. Reaching here means the address did not resolve to an
  // account through the branch above — either nothing owns it, or the incoming
  // token did not assert it as verified.
  //
  // The second case must not fall through into account creation. It used to be
  // caught by AuthUser.email's unique index, because a social sign-up wrote the
  // provider address there; now that it does not, an unverified token claiming
  // an address an account already owns would quietly found a SECOND account on
  // it. Refused instead, with the same AUTH_EMAIL_EXISTS the check below uses
  // so nothing new is leaked about who owns what.
  if (existingUser) {
    throw new ConflictError("AUTH_EMAIL_EXISTS");
  }

  // An admin account in backoffice's admin_db may hold the address — the branch
  // above never sees that database, and no index spans the two. Existing users
  // keep signing in through the branches above; only creating a NEW account on
  // an admin's email is refused.
  await assertEmailAvailable(profile.email);

  const accountBase = buildSocialAccountBase(
    provider === "GOOGLE" ? "google" : "apple",
    profile.sub,
    profile.email
  );
  const account = await generateUniqueAccount(accountBase);

  const user = await authRepository.createUserWithLinkedAccount({
    account,
    // The PROFILE email stays EMPTY. A Google/Apple address is the provider's,
    // not something the user chose to publish on this account, and the Settings
    // "Email" row renders this column — so writing it here made signing in with
    // Google silently populate a field the user never filled in. The address is
    // kept on the link below (`providerEmail`), where the Linked Accounts
    // section reads it and where sign-in resolves it.
    email: null,
    emailVerified: false,
    provider: authProvider,
    providerUserId: profile.sub,
    // The provider that created the account IS its first sign-in method.
    primaryAccount: authProvider,
    displayName: profile.displayName,
    providerEmail: profile.email,
    providerEmailVerified: profile.emailVerified,
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

  const session = buildSessionContext(req, device);

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
    // Same shared rule every other flow answers with (@aimess/utils), applied
    // to the exact values user-service is about to seed the profile with: the
    // username it generates from `account` is always present, so the answer
    // turns on whether the provider supplied both names. A Google/Apple sign-up
    // that carried a full name is complete on its first response instead of
    // being sent to the profile-details screen it has nothing left to fill in.
    // The avatar is not part of the rule and no provider branch exists here.
    isProfileCompleted: isProfileComplete({
      username: account,
      firstName: profile.firstName,
      lastName: profile.lastName,
    }),
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
      input.fcmTokens,
      input.device
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
      input.fcmTokens,
      input.device
    );
  },
};

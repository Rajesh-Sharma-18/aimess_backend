import { ConflictError } from "@aimess/errors";

export type LinkedIdentityState = {
  email: string | null;
  emailVerified: boolean;
  _count: { linkedAccounts: number };
};

/**
 * An account holds its founding sign-in method plus AT MOST ONE additional
 * identity: an OTP-verified email OR a Google/Apple link, never both. A
 * Google/Apple-founded account already spends that slot on its own link, so it
 * can link nothing further.
 *
 * Legacy rows that already hold several identities are left intact and simply
 * report the slot as taken.
 */
export function hasLinkedIdentity(state: LinkedIdentityState): boolean {
  return (
    (Boolean(state.email) && state.emailVerified) ||
    state._count.linkedAccounts > 0
  );
}

export function assertCanLinkIdentity(state: LinkedIdentityState): void {
  if (hasLinkedIdentity(state)) {
    throw new ConflictError("AUTH_LINKED_IDENTITY_LIMIT");
  }
}

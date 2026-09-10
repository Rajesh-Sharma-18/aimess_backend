/**
 * `resolveRequiredSocialProvider` — which provider a password-less account has
 * to be sent to.
 *
 * Only the ambiguous rows are interesting: an account with both providers
 * linked, and one whose `primaryAccount` names something that is not a usable
 * social link (EMAIL, or null on a row written before the column existed).
 */
import { AuthProvider } from "../../src/generated/prisma/client.js";
import { resolveRequiredSocialProvider } from "../../src/lib/sign-in-methods.js";

const link = (provider: AuthProvider) => ({ provider });

describe("resolveRequiredSocialProvider", () => {
  it("returns null when nothing social is linked", () => {
    expect(
      resolveRequiredSocialProvider({
        primaryAccount: AuthProvider.EMAIL,
        linkedAccounts: [link(AuthProvider.EMAIL)],
      })
    ).toBeNull();
  });

  it.each([AuthProvider.GOOGLE, AuthProvider.APPLE])(
    "returns the only linked provider (%s)",
    (provider) => {
      expect(
        resolveRequiredSocialProvider({
          primaryAccount: provider,
          linkedAccounts: [link(provider)],
        })
      ).toBe(provider);
    }
  );

  it("prefers primaryAccount when both providers are linked", () => {
    expect(
      resolveRequiredSocialProvider({
        primaryAccount: AuthProvider.APPLE,
        // Google first, so a plain "take the oldest" rule would answer GOOGLE.
        linkedAccounts: [link(AuthProvider.GOOGLE), link(AuthProvider.APPLE)],
      })
    ).toBe(AuthProvider.APPLE);
  });

  it("falls back to the oldest link when primaryAccount cannot decide", () => {
    // The repository orders links by linkedAt ascending, so element 0 is the
    // identity that founded the account.
    expect(
      resolveRequiredSocialProvider({
        primaryAccount: AuthProvider.EMAIL,
        linkedAccounts: [link(AuthProvider.GOOGLE), link(AuthProvider.APPLE)],
      })
    ).toBe(AuthProvider.GOOGLE);
  });

  it("falls back to the oldest link when primaryAccount is null", () => {
    expect(
      resolveRequiredSocialProvider({
        primaryAccount: null,
        linkedAccounts: [link(AuthProvider.APPLE)],
      })
    ).toBe(AuthProvider.APPLE);
  });
});

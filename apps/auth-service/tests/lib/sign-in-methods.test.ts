/**
 * `passwordUnavailableCode` — what a password-less account is told to use
 * instead. Decided by the providers linked NOW, not by how it was founded.
 */
import { AuthProvider } from "../../src/generated/prisma/client.js";
import { passwordUnavailableCode } from "../../src/lib/sign-in-methods.js";

const links = (...providers: AuthProvider[]) => ({
  linkedAccounts: providers.map((provider) => ({ provider })),
});

describe("passwordUnavailableCode", () => {
  it.each([
    [[], "AUTH_PASSWORD_NOT_SET"],
    [[AuthProvider.EMAIL], "AUTH_PASSWORD_NOT_SET"],
    [[AuthProvider.GOOGLE], "AUTH_GOOGLE_LOGIN_REQUIRED"],
    [[AuthProvider.APPLE], "AUTH_APPLE_LOGIN_REQUIRED"],
    [[AuthProvider.EMAIL, AuthProvider.APPLE], "AUTH_APPLE_LOGIN_REQUIRED"],
    [[AuthProvider.GOOGLE, AuthProvider.APPLE], "AUTH_SOCIAL_LOGIN_REQUIRED"],
    [[AuthProvider.APPLE, AuthProvider.GOOGLE], "AUTH_SOCIAL_LOGIN_REQUIRED"],
  ] as const)("%j -> %s", (providers, expected) => {
    expect(passwordUnavailableCode(links(...providers))).toBe(expected);
  });
});

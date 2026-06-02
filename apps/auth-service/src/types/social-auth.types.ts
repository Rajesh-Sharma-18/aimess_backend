import type { AuthTokensResponse } from "./auth.types.js";

export type SocialAuthProvider = "GOOGLE" | "APPLE";

export type SocialLoginResult = {
  isNewUser: boolean;
  user: {
    userId: string;
    account: string;
    email: string | null;
    provider: SocialAuthProvider;
  };
  /** Whether the user has filled in their required profile fields; lets the
   * client route to the edit-profile screen on first login. */
  isProfileCompleted: boolean;
  tokens: AuthTokensResponse;
};

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
  tokens: AuthTokensResponse;
};

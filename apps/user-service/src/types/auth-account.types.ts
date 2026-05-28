export type SignInProvider = "EMAIL" | "GOOGLE" | "APPLE";

/** How sign-in provider data was loaded on GET /accounts/me. */
export type AccountLoadStatus = "live" | "cached" | "unavailable";

export type ConnectedProviderInfo = {
  provider: SignInProvider;
  connected: boolean;
  providerUserId: string | null;
  providerEmail: string | null;
  linkedAt: string | null;
};

export type AuthAccountSummary = {
  userId: string;
  account: string;
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  providers: ConnectedProviderInfo[];
};

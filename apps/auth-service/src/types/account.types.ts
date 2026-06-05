export type SignInProvider = "EMAIL" | "GOOGLE" | "APPLE";

export type ConnectedProviderInfo = {
  provider: SignInProvider;
  connected: boolean;
  /** Google `sub`, Apple `sub`, or primary email for EMAIL. */
  providerUserId: string | null;
  /** Email reported by the provider (social) or same as primary for EMAIL. */
  providerEmail: string | null;
  linkedAt: string | null;
};

export type AccountSummaryResponse = {
  userId: string;
  account: string;
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  /** First sign-in method ever linked; set once and never overwritten. */
  primaryAccount: SignInProvider | null;
  providers: ConnectedProviderInfo[];
};

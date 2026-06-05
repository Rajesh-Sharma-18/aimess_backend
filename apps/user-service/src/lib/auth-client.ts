import { authGrpcClient } from "../grpc/auth.client.js";
import type { AuthAccountSummary } from "../types/auth-account.types.js";

export async function fetchAuthAccountSummary(
  userId: string
): Promise<AuthAccountSummary> {
  const result = await authGrpcClient.getAccountSummary(userId);

  // Map proto response to the existing AuthAccountSummary shape.
  return {
    userId: result.userId,
    account: result.account,
    email: result.email === "" ? null : result.email,
    emailVerified: result.emailVerified,
    hasPassword: result.hasPassword,
    primaryAccount:
      result.primaryAccount === ""
        ? null
        : (result.primaryAccount as "EMAIL" | "GOOGLE" | "APPLE"),
    providers: result.providers.map((p) => ({
      provider: p.provider as "EMAIL" | "GOOGLE" | "APPLE",
      connected: p.connected,
      providerUserId: p.providerUserId === "" ? null : p.providerUserId,
      providerEmail: p.providerEmail === "" ? null : p.providerEmail,
      linkedAt: p.linkedAt === "" ? null : p.linkedAt,
    })),
  };
}

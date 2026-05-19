import { UnauthorizedError } from "@aimess/errors";

import { env } from "../config/env.js";
import type { AuthAccountSummary } from "../types/auth-account.types.js";

type AuthApiEnvelope<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

export async function fetchAuthAccountSummary(
  accessToken: string
): Promise<AuthAccountSummary> {
  const url = `${env.AUTH_SERVICE_URL.replace(/\/$/, "")}/api/auth/internal/account`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(env.AUTH_SERVICE_TIMEOUT_MS),
  });

  const body = (await response.json()) as AuthApiEnvelope<AuthAccountSummary>;

  if (response.status === 401) {
    throw new UnauthorizedError("AUTH_UNAUTHORIZED");
  }

  if (!response.ok || !body.success || !body.data) {
    throw new Error(`Auth account fetch failed with status ${response.status}`);
  }

  return body.data;
}

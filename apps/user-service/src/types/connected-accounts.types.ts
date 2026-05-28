import type {
  AccountLoadStatus,
  ConnectedProviderInfo,
} from "./auth-account.types.js";

/** GET /accounts/me — linked sign-in providers from auth-service. */
export type ConnectedAccountsResponse = {
  /** Null when auth-service is down and no cached copy exists. */
  providers: ConnectedProviderInfo[] | null;
  /** `live` = fresh from auth; `cached` = auth down, stale copy; `unavailable` = auth down, no cache. */
  accountStatus: AccountLoadStatus;
};

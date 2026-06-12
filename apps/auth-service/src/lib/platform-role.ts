import type { PlatformRole } from "@aimess/auth-jwt";

import type { GlobalRole } from "../generated/prisma/client.js";

/**
 * Normalize auth-service's Prisma `GlobalRole` to the access-token
 * `PlatformRole` claim. Defensive: any value other than `ADMIN` (a future enum
 * member, or a missing user row) collapses to the non-privileged `USER`, so a
 * new role can never be accidentally minted with platform-admin rights.
 */
export function toPlatformRole(
  role: GlobalRole | null | undefined
): PlatformRole {
  return role === "ADMIN" ? "ADMIN" : "USER";
}

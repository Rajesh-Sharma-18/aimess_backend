import { ConflictError } from "@aimess/errors";

/**
 * Two accounts verifying the SAME email concurrently both pass the
 * `findEmailTakenByOtherUser` pre-check; the loser then hits the unique index
 * on `AuthUser.email` (Prisma P2002). Translate that into the same 409 the
 * pre-check produces so the race is indistinguishable from the ordinary
 * "already linked elsewhere" case instead of surfacing a 500.
 */
export function rethrowAsEmailConflict(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  ) {
    throw new ConflictError("AUTH_EMAIL_EXISTS");
  }

  throw error;
}

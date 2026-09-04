import { createHash } from "node:crypto";

import { logger } from "@aimess/logger";
import type { UserPurgedPayload } from "@aimess/shared-types";

import { prisma } from "../config/prisma.js";

/**
 * Erase this service's copy of a purged user's personal data.
 *
 * `user.deleted` only flipped `deletedAt` and `status` — username, first and
 * last name, bio, avatar, date of birth and the search shadows were all left
 * intact, and the "Deleted Account" the platform displayed was a read-time
 * projection over that live data. So a user who deleted their account still had
 * their real name and photo stored here indefinitely, and any read path that
 * forgot the projection would show it.
 *
 * The row survives because the rest of the platform references its id. Every
 * value that identifies a person does not.
 *
 * Idempotent: a redelivered message re-writes the same derived placeholders, so
 * a replay from the dead-letter queue is safe.
 */
export async function handleUserPurged(data: UserPurgedPayload): Promise<void> {
  // Derived, not random: stable across a replay, unique across users (so the
  // unique index on `username` is satisfied), and not reversible into the
  // original handle.
  const tag = createHash("sha256")
    .update(`aimess:purge:${data.userId}`)
    .digest("hex")
    .slice(0, 16);
  const placeholderUsername = `deleted_${tag}`;

  const result = await prisma.userProfile.updateMany({
    where: { userId: data.userId },
    data: {
      username: placeholderUsername,
      firstName: "Deleted",
      lastName: "Account",
      // The search shadows are lowercase/de-spaced copies of the name columns.
      // Leaving them would keep the real name searchable after the name itself
      // was erased — the exact leak the erasure is meant to close.
      normalizedUsername: placeholderUsername,
      normalizedFirstName: "deleted",
      normalizedLastName: "account",
      normalizedFullName: "deletedaccount",
      // The login handle mirrored from auth-service — also user-chosen, and
      // also often a real name.
      account: null,
      bio: null,
      gender: null,
      avatarUrl: null,
      coverImageUrl: null,
      // Not nullable in the schema, and a real birth date is personal data;
      // the epoch is an unmistakable "erased" marker rather than a plausible
      // date that could be mistaken for real.
      dateOfBirth: new Date(0),
    },
  });

  if (result.count === 0) {
    // Not an error worth retrying: an account can be purged without ever having
    // completed a profile here.
    logger.info(
      `user.purged: no profile to erase for user=${data.userId} (never created)`
    );
    return;
  }

  logger.info(`user.purged: erased profile personal data for ${data.userId}`);
}

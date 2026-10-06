import { BadRequestError } from "@aimess/errors";

import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { userCache } from "../lib/user-cache.js";
import {
  isValidUsernameFormat,
  normalizeUsername,
  usernameBaseFromAccount,
  usernameWithSuffix,
} from "../lib/username.util.js";

export type UsernameAvailabilityResult = {
  username: string;
  /** True if nobody else uses this handle, or it is already yours (same `excludeUserId`). */
  available: boolean;
};

export class UsernameService {
  /**
   * Suggest a handle for `account`: the bare base when free, else `base_1`,
   * `base_2`, … (first free). `excludeUserId` is the caller — registration seeds
   * the profile row with a username, so without it the user's OWN handle reads
   * as taken and the suggestion jumps a suffix. A suggestion is not a claim; the
   * unique index decides at save time.
   */
  async generateFromAccount(
    account: string,
    excludeUserId?: string
  ): Promise<{ username: string }> {
    const base = usernameBaseFromAccount(account);

    if (!isValidUsernameFormat(base)) {
      throw new BadRequestError("INVALID_USERNAME_FORMAT");
    }

    const username = await this.findAvailableUsername(base, excludeUserId);
    return { username };
  }

  async validateAvailability(
    username: string,
    excludeUserId?: string
  ): Promise<UsernameAvailabilityResult> {
    const canonical = normalizeUsername(username);
    if (!isValidUsernameFormat(canonical)) {
      throw new BadRequestError("INVALID_USERNAME_FORMAT");
    }

    const cached = await userCache.getUsernameAvailability(
      canonical,
      excludeUserId
    );
    let available: boolean;
    if (cached !== null) {
      available = cached.available;
    } else {
      ({ available } = await this.resolveUsernameAvailability(
        canonical,
        excludeUserId
      ));
      await userCache.setUsernameAvailability(
        canonical,
        excludeUserId,
        available
      );
    }

    // Holds expire on their own, so they are checked live, never cached.
    if (available) {
      const holder = await userCache.getUsernameHolder(canonical);
      available = holder === null || holder === excludeUserId;
    }

    return { username: canonical, available };
  }

  private async resolveUsernameAvailability(
    username: string,
    excludeUserId?: string
  ): Promise<UsernameAvailabilityResult> {
    const existing = await this.findProfileByUsername(username);

    if (!existing) {
      return { username, available: true };
    }

    if (excludeUserId !== undefined && existing.userId === excludeUserId) {
      return { username, available: true };
    }

    return { username, available: false };
  }

  private async findProfileByUsername(username: string) {
    return userProfileRepository.findByUsername(username);
  }

  private async isUsernameTaken(
    username: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const canonical = normalizeUsername(username);
    // The taken-cache does not record the owner, so it may only short-circuit
    // when there is no "self" to exclude.
    if (excludeUserId === undefined) {
      const cachedTaken = await userCache.getUsernameTaken(canonical);
      if (cachedTaken === true) {
        return true;
      }
    }

    // Unfiltered by status on purpose: a BANNED profile keeps its handle (no
    // impersonation); a purged one already had it swapped for a placeholder.
    const existing = await this.findProfileByUsername(canonical);
    if (!existing) {
      return false;
    }

    await userCache.markUsernameTaken(canonical);
    return existing.userId !== excludeUserId;
  }

  private async findAvailableUsername(
    base: string,
    excludeUserId?: string
  ): Promise<string> {
    const canonicalBase = normalizeUsername(base);

    // n=0 is the bare base; suffixes only after it.
    for (let suffix = 0; suffix <= 9999; suffix += 1) {
      const candidate =
        suffix === 0
          ? canonicalBase
          : usernameWithSuffix(canonicalBase, suffix);
      if (!isValidUsernameFormat(candidate)) {
        continue;
      }

      if (await this.isUsernameTaken(candidate, excludeUserId)) {
        continue;
      }

      // A user asking for a suggestion holds it for 5 minutes; registration
      // (no caller) just steps around anyone else's hold.
      const reserved =
        excludeUserId === undefined
          ? (await userCache.getUsernameHolder(candidate)) === null
          : await userCache.claimUsernameHold(candidate, excludeUserId);
      if (reserved) {
        return candidate;
      }
    }

    throw new BadRequestError("USERNAME_GENERATION_FAILED");
  }
}

export const usernameService = new UsernameService();

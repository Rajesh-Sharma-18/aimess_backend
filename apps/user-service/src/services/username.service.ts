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
  async generateFromAccount(account: string): Promise<{ username: string }> {
    const base = usernameBaseFromAccount(account);

    if (!isValidUsernameFormat(base)) {
      throw new BadRequestError("INVALID_USERNAME_FORMAT");
    }

    const username = await this.findAvailableUsername(base);
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
    if (cached !== null) {
      return {
        username: canonical,
        available: cached.available,
      };
    }

    const result = await this.resolveUsernameAvailability(
      canonical,
      excludeUserId
    );
    await userCache.setUsernameAvailability(
      canonical,
      excludeUserId,
      result.available
    );

    return result;
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

  private async isUsernameTaken(username: string): Promise<boolean> {
    const canonical = normalizeUsername(username);
    const cachedTaken = await userCache.getUsernameTaken(canonical);
    if (cachedTaken === true) {
      return true;
    }

    const existing = await this.findProfileByUsername(canonical);
    if (existing) {
      await userCache.markUsernameTaken(canonical);
      return true;
    }

    return false;
  }

  private async findAvailableUsername(base: string): Promise<string> {
    const canonicalBase = normalizeUsername(base);
    if (!(await this.isUsernameTaken(canonicalBase))) {
      return canonicalBase;
    }

    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      const candidate = usernameWithSuffix(canonicalBase, suffix);
      if (!isValidUsernameFormat(candidate)) {
        continue;
      }

      if (!(await this.isUsernameTaken(candidate))) {
        return candidate;
      }
    }

    throw new BadRequestError("USERNAME_GENERATION_FAILED");
  }
}

export const usernameService = new UsernameService();

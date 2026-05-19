import { BadRequestError } from "@aimess/errors";

import { prisma } from "../config/prisma.js";
import { userCache } from "../lib/user-cache.js";
import {
  isValidUsernameFormat,
  usernameBaseFromAccount,
  usernameWithSuffix,
} from "../lib/username.util.js";
import { logger } from "@aimess/logger";

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
  ): Promise<{ username: string; available: boolean }> {
    if (!isValidUsernameFormat(username)) {
      throw new BadRequestError("INVALID_USERNAME_FORMAT");
    }

    const cached = await userCache.getUsernameAvailability(
      username,
      excludeUserId
    );
    logger.info(`Cached: ${cached}`);
    if (cached !== null) {
      return { username, available: cached.available };
    }

    const available = await this.isUsernameAvailable(username, excludeUserId);
    logger.info(`Available: ${available}`);
    await userCache.setUsernameAvailability(username, excludeUserId, available);

    return { username, available };
  }

  private async isUsernameAvailable(
    username: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const existing = await this.findProfileByUsername(username);

    return (
      !existing ||
      (excludeUserId !== undefined && existing.userId === excludeUserId)
    );
  }

  private async findProfileByUsername(username: string) {
    return prisma.userProfile.findUnique({
      where: { username },
      select: { userId: true },
    });
  }

  private async isUsernameTaken(username: string): Promise<boolean> {
    const cachedTaken = await userCache.getUsernameTaken(username);
    if (cachedTaken === true) {
      return true;
    }

    const existing = await this.findProfileByUsername(username);
    if (existing) {
      await userCache.markUsernameTaken(username);
      return true;
    }

    return false;
  }

  private async findAvailableUsername(base: string): Promise<string> {
    if (!(await this.isUsernameTaken(base))) {
      return base;
    }

    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      const candidate = usernameWithSuffix(base, suffix);
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

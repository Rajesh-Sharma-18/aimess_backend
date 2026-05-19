import { authRepository } from "../repositories/auth.repository.js";

export const accountAvailabilityService = {
  async validateAvailability(
    account: string
  ): Promise<{ account: string; available: boolean }> {
    const normalized = account.trim();
    const existing = await authRepository.findByAccount(normalized);

    return {
      account: normalized,
      available: !existing,
    };
  },
};

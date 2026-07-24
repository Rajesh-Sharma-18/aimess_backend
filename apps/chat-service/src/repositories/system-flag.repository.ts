import type { PrismaClient, SystemFlag } from "../generated/prisma/index.js";

/**
 * Platform-wide feature switches owned by chat-service (see `SystemFlag` in
 * prisma/schema.prisma). Persisted rather than held in Redis so an admin's
 * decision survives a restart or cache flush.
 */
export class SystemFlagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** `null` when the flag has never been set — callers apply their own default. */
  findByKey(key: string): Promise<SystemFlag | null> {
    return this.prisma.systemFlag.findUnique({ where: { key } });
  }

  upsert(params: {
    key: string;
    enabled: boolean;
    updatedBy?: string | null;
  }): Promise<SystemFlag> {
    return this.prisma.systemFlag.upsert({
      where: { key: params.key },
      update: { enabled: params.enabled, updatedBy: params.updatedBy ?? null },
      create: {
        key: params.key,
        enabled: params.enabled,
        updatedBy: params.updatedBy ?? null,
      },
    });
  }
}

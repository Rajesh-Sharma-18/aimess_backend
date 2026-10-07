import type {
  ForwardedMediaGrant,
  PrismaClient,
} from "../generated/prisma/index.js";

export type MediaGrantScope = "PRIVATE_CHAT" | "GROUP_CHAT" | "COMMUNITY_CHAT";

export class ForwardedMediaGrantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Idempotent: keys already granted to this room+scope are skipped. */
  async grant(
    roomId: string,
    scope: MediaGrantScope,
    objectKeys: string[]
  ): Promise<void> {
    if (objectKeys.length === 0) return;
    const existing = await this.prisma.forwardedMediaGrant.findMany({
      where: { roomId, scope, objectKey: { in: objectKeys } },
      select: { objectKey: true },
    });
    const have = new Set(existing.map((g) => g.objectKey));
    const missing = objectKeys.filter((k) => !have.has(k));
    if (missing.length === 0) return;
    await this.prisma.forwardedMediaGrant.createMany({
      data: missing.map((objectKey) => ({ objectKey, roomId, scope })),
    });
  }

  findByObjectKey(objectKey: string): Promise<ForwardedMediaGrant[]> {
    return this.prisma.forwardedMediaGrant.findMany({ where: { objectKey } });
  }
}

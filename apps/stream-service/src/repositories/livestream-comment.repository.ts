import type {
  PrismaClient,
  LivestreamComment,
} from "../generated/prisma/index.js";

export class LivestreamCommentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createComment(data: {
    livestreamId: string;
    sentBy: string;
    senderName?: string;
    senderAvatar?: string;
    message: string;
    clientCommentId?: string | null;
  }): Promise<LivestreamComment> {
    return this.prisma.livestreamComment.create({
      data: {
        livestreamId: data.livestreamId,
        sentBy: data.sentBy,
        senderName: data.senderName ?? "",
        senderAvatar: data.senderAvatar ?? "",
        message: data.message,
        clientCommentId: data.clientCommentId ?? null,
      },
    });
  }

  async findById(id: string): Promise<LivestreamComment | null> {
    return this.prisma.livestreamComment.findUnique({ where: { id } });
  }

  async findByIds(ids: string[]): Promise<LivestreamComment[]> {
    if (ids.length === 0) return [];
    return this.prisma.livestreamComment.findMany({
      where: { id: { in: ids } },
    });
  }

  async deleteById(id: string): Promise<void> {
    try {
      await this.prisma.livestreamComment.delete({ where: { id } });
    } catch (err: unknown) {
      // P2025 = record not found — treat concurrent deletes as idempotent
      if ((err as { code?: string }).code === "P2025") return;
      throw err;
    }
  }

  /** Idempotency lookup — matching (livestreamId, sentBy, clientCommentId). */
  async findByClientCommentId(
    livestreamId: string,
    sentBy: string,
    clientCommentId: string
  ): Promise<LivestreamComment | null> {
    return this.prisma.livestreamComment.findFirst({
      where: { livestreamId, sentBy, clientCommentId },
    });
  }

  /**
   * Cursor-paged comment query.
   * - `before`: newest-first, id < before (scroll back through history).
   * - `after`:  oldest-first, id > after  (catch-up after a reconnect gap).
   * Only one of before/after should be set; before takes precedence if both given.
   */
  async findByLivestreamId(
    livestreamId: string,
    options: { limit: number; before?: string; after?: string }
  ): Promise<LivestreamComment[]> {
    const isAfter = !options.before && !!options.after;
    return this.prisma.livestreamComment.findMany({
      where: {
        livestreamId,
        ...(options.before ? { id: { lt: options.before } } : {}),
        ...(isAfter ? { id: { gt: options.after } } : {}),
      },
      orderBy: { id: isAfter ? "asc" : "desc" },
      take: options.limit,
    });
  }
}

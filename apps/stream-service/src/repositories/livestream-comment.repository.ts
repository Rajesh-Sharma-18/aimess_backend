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
   * Newest-first cursor page. When `before` is given, returns comments with
   * id < before (older). Used by REST + gRPC GetComments.
   */
  async findByLivestreamId(
    livestreamId: string,
    options: { limit: number; before?: string }
  ): Promise<LivestreamComment[]> {
    return this.prisma.livestreamComment.findMany({
      where: {
        livestreamId,
        ...(options.before ? { id: { lt: options.before } } : {}),
      },
      orderBy: { id: "desc" },
      take: options.limit,
    });
  }
}

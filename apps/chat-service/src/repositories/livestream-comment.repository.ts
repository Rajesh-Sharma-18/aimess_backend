import type {
  PrismaClient,
  LivestreamComment,
} from "../generated/prisma/index.js";

export class LivestreamCommentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createComment(data: {
    livestreamId: string;
    roomId: string;
    sentBy: string;
    senderName: string;
    senderAvatar: string;
    message: string;
    clientCommentId: string | null;
  }): Promise<LivestreamComment> {
    return this.prisma.livestreamComment.create({ data });
  }

  async findByClientCommentId(
    livestreamId: string,
    sentBy: string,
    clientCommentId: string
  ): Promise<LivestreamComment | null> {
    return this.prisma.livestreamComment.findFirst({
      where: { livestreamId, sentBy, clientCommentId },
    });
  }

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

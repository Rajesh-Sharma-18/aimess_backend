import type { LivestreamComment } from "../generated/prisma/index.js";
import type { LivestreamCommentRepository } from "../repositories/livestream-comment.repository.js";

export class LivestreamCommentService {
  constructor(private readonly commentRepo: LivestreamCommentRepository) {}

  async addComment(params: {
    livestreamId: string;
    roomId: string;
    userId: string;
    userName: string;
    userAvatar: string;
    message: string;
    clientCommentId?: string | null;
  }): Promise<LivestreamComment> {
    // Idempotency check
    if (params.clientCommentId) {
      const existing = await this.commentRepo.findByClientCommentId(
        params.livestreamId,
        params.userId,
        params.clientCommentId
      );
      if (existing) return existing;
    }

    return this.commentRepo.createComment({
      livestreamId: params.livestreamId,
      roomId: params.roomId,
      sentBy: params.userId,
      senderName: params.userName,
      senderAvatar: params.userAvatar,
      message: params.message,
      clientCommentId: params.clientCommentId || null,
    });
  }

  async getComments(
    livestreamId: string,
    options: { limit: number; before?: string }
  ): Promise<LivestreamComment[]> {
    return this.commentRepo.findByLivestreamId(livestreamId, options);
  }
}

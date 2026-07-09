/**
 * Suite: LivestreamCommentService.addComment — stream:comment:new broadcast shape
 *
 * The Redis-published `stream:comment:new` payload must mirror the canonical
 * community/private chat message shape (see chat-service's
 * buildChatMessageEvent / the community:message:new broadcast) so a client
 * renders a live comment through the same message component as chat.
 * `parentCommentId`, `quoteData` and `content.files` are reserved for future
 * reply/media support and must always be empty until that ships.
 */
import { LivestreamCommentService } from "../../src/services/livestream-comment.service.js";

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream-1",
    communityId: "comm-1",
    creatorId: "creator-1",
    title: "t",
    description: "",
    thumbnail: null,
    sourceType: "PHONE_CAMERA",
    sourceUrl: null,
    streamKey: "key-1",
    status: "LIVE",
    hlsUrl: null,
    flvUrl: null,
    dashUrl: null,
    commentStatus: true,
    viewerCount: 0,
    peakViewers: 0,
    totalViews: 0,
    totalComments: 0,
    livedAt: new Date(),
    endedAt: null,
    lastHeartbeatAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const commentRepo = {
    findByClientCommentId: jest.fn().mockResolvedValue(null),
    createComment: jest
      .fn()
      .mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve({
          id: "comment-1",
          livestreamId: data.livestreamId,
          sentBy: data.sentBy,
          senderName: data.senderName ?? "",
          senderAvatar: data.senderAvatar ?? "",
          message: data.message,
          clientCommentId: data.clientCommentId ?? null,
          createdAt: new Date(1700000000000),
          updatedAt: new Date(1700000000000),
        })
      ),
    findByLivestreamId: jest.fn().mockResolvedValue([]),
    ...(overrides.commentRepo as object),
  };
  const streamRepo = {
    findById: jest.fn().mockResolvedValue(makeStream()),
    incrementTotalComments: jest.fn().mockResolvedValue(undefined),
    ...(overrides.streamRepo as object),
  };
  const userClient = {
    bulkGetUserSnapshots: jest.fn().mockResolvedValue([
      {
        userId: "member-1",
        username: "member_one",
        displayName: "Member One",
        avatarObjectKey: "avatars/member-1.jpg",
      },
    ]),
    ...(overrides.userClient as object),
  };
  const redis = {
    publish: jest.fn().mockResolvedValue(undefined),
    ...(overrides.redis as object),
  };
  const banRepo = {
    isBanned: jest.fn().mockResolvedValue(false),
    ...(overrides.banRepo as object),
  };
  const communityClient = {
    checkMute: jest.fn().mockResolvedValue({ isMuted: false }),
    checkBan: jest.fn().mockResolvedValue({ isBanned: false }),
    validateMembership: jest.fn().mockResolvedValue({
      isMember: true,
      isCommunityClosed: false,
    }),
    ...(overrides.communityClient as object),
  };
  const reportRepo = {} as any;

  const service = new LivestreamCommentService(
    commentRepo as any,
    streamRepo as any,
    userClient as any,
    redis as any,
    banRepo as any,
    communityClient as any,
    reportRepo
  );

  return { service, commentRepo, streamRepo, banRepo, communityClient, redis };
}

describe("LivestreamCommentService.addComment — stream:comment:new broadcast shape", () => {
  it("publishes a payload matching the community/private chat message shape", async () => {
    const { service, redis } = makeDeps();

    const dto = await service.addComment({
      livestreamId: "stream-1",
      userId: "member-1",
      message: "heee",
      clientCommentId: "E6EA0269-CD8F-4A26-97BE-77EC7ADB8C23",
    });

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0];
    expect(channel).toBe("stream:stream-1");
    const parsed = JSON.parse(raw as string);
    expect(parsed.event).toBe("stream:comment:new");
    expect(parsed.data).toEqual({
      id: "comment-1",
      commentId: "comment-1",
      streamId: "stream-1",
      senderId: "member-1",
      senderName: "member_one",
      senderAvatar: "avatars/member-1.jpg",
      parentCommentId: "",
      quoteData: null,
      content: { text: "heee", files: [] },
      message: "heee",
      contentType: "TEXT",
      isEdited: false,
      editedAt: 0,
      clientCommentId: "E6EA0269-CD8F-4A26-97BE-77EC7ADB8C23",
      serverTs: dto.createdAt.getTime(),
      sentAt: dto.createdAt.getTime(),
    });
  });

  it("echoes an empty clientCommentId when the caller didn't supply one", async () => {
    const { service, redis } = makeDeps();

    await service.addComment({
      livestreamId: "stream-1",
      userId: "member-1",
      message: "no client id",
    });

    const parsed = JSON.parse(redis.publish.mock.calls[0][1] as string);
    expect(parsed.data.clientCommentId).toBe("");
  });
});

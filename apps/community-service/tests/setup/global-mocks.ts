/**
 * Global I/O-boundary mocks for community-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch real
 * infrastructure or pull in ESM-only / native libs that CommonJS-mode Jest
 * cannot `require` (gRPC proto loading via `import.meta`, MinIO/S3 client, ioredis).
 * Per-test files may re-`jest.mock()` any of these to inject richer behaviour
 * for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 */

// --- Datastore: never open a real Mongo/Prisma connection -----------------
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
}));

// --- Redis: never open a real connection. Cache treated as not-ready so the
//     cache-first read paths fall straight through to the (mocked) repos. ----
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready" },
  isCommunityCacheReady: jest.fn(() => false),
  connectCommunityRedis: jest.fn(async () => undefined),
  disableCommunityCache: jest.fn(),
}));

// --- MinIO / S3 storage clients: avoid constructing the AWS SDK S3 client and
//     the media-URL strategy at import. Presign/head/delete are never hit by
//     the smoke route; per-test specs re-mock with real fns when needed. ------
jest.mock("../../src/config/storage.js", () => ({
  storageClient: {},
  presignClient: {},
  mediaUrlStrategy: {
    toViewUrl: jest.fn(async () => null),
    buildMediaObject: jest.fn(async () => null),
  },
}));

// --- user-service gRPC client: the real module runs `protoLoader.loadSync`
//     against a path derived from `import.meta.url` AND constructs a gRPC
//     client at import time (breaks under CJS-mode Jest, pulls native
//     @grpc/grpc-js). Stub the wrapper object. --------------------------------
jest.mock("../../src/grpc/user.client.js", () => ({
  userGrpcClient: {
    bulkGetUserSnapshots: jest.fn(async () => []),
    checkFriendships: jest.fn(async () => []),
  },
}));

// --- chat-service gRPC client: created lazily, but stub it so no proto load /
//     gRPC channel is ever attempted under test. -----------------------------
const chatClientStub = () => ({
  getCommunityChatSummaries: jest.fn(async () => []),
  bulkMarkCommunityRead: jest.fn(async () => 0),
  ensureCommunityRoom: jest.fn(async () => true),
  getCommunityMessageById: jest.fn(async () => ({
    found: false,
    message: "",
    contentType: "",
    postedAt: 0,
    senderId: "",
    media: [],
  })),
});
jest.mock("../../src/grpc/chat.client.js", () => ({
  getChatClient: jest.fn(() => chatClientStub()),
  createChatClient: jest.fn(() => chatClientStub()),
}));

// --- stream-service gRPC client: created lazily, but stub it so no proto load
//     (path derived from `import.meta.url`) / gRPC channel is ever attempted
//     under test. Without this, the real module is transpiled to CJS and its
//     top-level `const __dirname` collides with the wrapper-provided binding. --
jest.mock("../../src/grpc/stream.client.js", () => ({
  getStreamClient: jest.fn(() => ({
    getActiveCommunityIds: jest.fn(async () => new Set()),
    getLiveStreamsByCommunity: jest.fn(async () => []),
  })),
  createStreamClient: jest.fn(() => ({
    getActiveCommunityIds: jest.fn(async () => new Set()),
    getLiveStreamsByCommunity: jest.fn(async () => []),
  })),
}));

// --- RabbitMQ publishers: fire-and-forget no-ops. The real modules import
//     amqplib and connect lazily; stub the *-Safe publishers so nothing is
//     ever queued or connected under test. ------------------------------------
jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunityCreatedForChatSafe: jest.fn(),
  publishCommunityMemberSyncedForChatSafe: jest.fn(),
  publishCommunityStatusChangedForChatSafe: jest.fn(),
  publishCommunityInviteLinkSharedForChatSafe: jest.fn(),
  publishCommunitySystemMessageForChatSafe: jest.fn(),
  publishCommunityVisibilityChangedForChatSafe: jest.fn(),
  publishCommunityDeletedForChatSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityMemberAddedSafe: jest.fn(),
  publishCommunityMemberKickedSafe: jest.fn(),
  publishCommunityMemberBannedSafe: jest.fn(),
  publishCommunityMemberMutedSafe: jest.fn(),
  publishCommunityMemberUnmutedSafe: jest.fn(),
  publishCommunityMemberWarnedSafe: jest.fn(),
  publishCommunityMemberRoleChangedSafe: jest.fn(),
  publishCommunityAdminTransferredSafe: jest.fn(),
  publishCommunityDeletedSafe: jest.fn(),
  publishCommunityClosedSafe: jest.fn(),
  publishCommunityMemberLeftSafe: jest.fn(),
  publishCommunityJoinRequestedSafe: jest.fn(),
  publishCommunityJoinRequestApprovedSafe: jest.fn(),
  publishCommunityJoinRequestRejectedSafe: jest.fn(),
  publishCommunityInviteSentSafe: jest.fn(),
  publishCommunityInviteAcceptedSafe: jest.fn(),
  publishCommunityReportCreatedSafe: jest.fn(),
  publishCommunityReportActionedSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-admin-report.js", () => ({
  publishAdminReportIngestSafe: jest.fn(),
}));

export {};

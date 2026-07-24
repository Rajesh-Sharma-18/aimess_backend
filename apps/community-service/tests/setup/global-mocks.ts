/**
 * Global I/O-boundary mocks for community-service (Jest setupFilesAfterEnv).
 *
 * Only the I/O boundary is mocked:
 *   - Redis client + Redis event publishers (@aimess/redis)
 *   - RabbitMQ publishers (publish-community, publish-community-chat)
 *   - Prisma repository layer
 *   - gRPC clients (chat, stream, user-client)
 *   - MinIO / storage (community-image-service, member-avatar-service)
 *   - Winston logger (silence suite stdout)
 *
 * The real service logic, validators, and @aimess/* package code execute for real.
 * `jest` is the Jest-injected global (typed by @types/jest).
 */

// --- Logger: swallow output so test stdout stays clean ---------------------
jest.mock("@aimess/logger", () => {
  const noop = () => undefined;
  const logger = {
    error: noop,
    warn: noop,
    info: noop,
    http: noop,
    verbose: noop,
    debug: noop,
    silly: noop,
    log: noop,
    child: () => logger,
  };
  return { logger, createChildLogger: () => logger };
});

// --- Redis client: prevent real ioredis connection ------------------------
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    exists: jest.fn(),
    keys: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(() => ({
      exec: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
    })),
  },
}));

// --- @aimess/redis: socket event publishers --------------------------------
jest.mock("@aimess/redis", () => ({
  publishChatUserEvent: jest.fn().mockResolvedValue(undefined),
  publishCommunityRoomEvent: jest.fn().mockResolvedValue(undefined),
}));

// --- Storage strategy: prevent real MinIO connections ---------------------
jest.mock("../../src/config/storage.js", () => ({
  mediaUrlStrategy: {
    presignGet: jest.fn().mockResolvedValue({ url: null, expiresAt: null }),
  },
}));

// --- Community repository: mock all DB calls ------------------------------
jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    create: jest.fn(),
    findById: jest.fn(),
    findByHandle: jest.fn(),
    findByHandleFull: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findMembership: jest.fn(),
    findMemberships: jest.fn().mockResolvedValue([]),
    findMemberByUserId: jest.fn(),
    findMembersByUserIds: jest.fn().mockResolvedValue([]),
    findActiveMemberIdsByRoles: jest.fn().mockResolvedValue([]),
    findActiveMemberIds: jest.fn().mockResolvedValue([]),
    findStreamMutedMemberIds: jest.fn().mockResolvedValue([]),
    countActiveMembers: jest.fn().mockResolvedValue(1),
    setMemberCount: jest.fn().mockResolvedValue(undefined),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    updateMember: jest.fn(),
    updateMemberStatus: jest.fn(),
    setMemberDismissed: jest.fn(),
    deleteMember: jest.fn(),
    findActiveMembers: jest.fn().mockResolvedValue([]),
    findPendingJoinRequest: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    findJoinRequestById: jest.fn(),
    recyclePendingJoinRequest: jest.fn(),
    updateJoinRequest: jest.fn(),
    createJoinRequest: jest.fn(),
    findInvite: jest.fn(),
    findInviteById: jest.fn(),
    updateInvite: jest.fn(),
    findInviteLink: jest.fn(),
    findInviteLinkByCode: jest.fn(),
    incrementInviteLinkUsageIfUnder: jest.fn(),
    updateInviteLink: jest.fn(),
    createInviteLink: jest.fn(),
    findReport: jest.fn(),
    createReport: jest.fn(),
    updateReport: jest.fn(),
    findAuditLogs: jest.fn().mockResolvedValue([]),
    createAuditLog: jest.fn().mockResolvedValue(undefined),
    findExpiredMemberMutes: jest.fn().mockResolvedValue([]),
    claimExpiredMemberMute: jest.fn().mockResolvedValue(0),
    listActiveMutesPage: jest.fn().mockResolvedValue([]),
    findActiveMemberMutesByUserIds: jest.fn().mockResolvedValue(new Map()),
    upsertMemberMute: jest.fn(),
    deleteMemberMute: jest.fn(),
    findMemberMute: jest.fn(),
    findCategories: jest.fn().mockResolvedValue([]),
    findCategory: jest.fn(),
    createCategory: jest.fn(),
    updateCategory: jest.fn(),
    deleteCategory: jest.fn(),
  },
}));

// --- RabbitMQ: community domain event publishers --------------------------
jest.mock("../../src/messaging/publish-community.js", () => ({
  publishCommunityMemberAddedSafe: jest.fn(),
  publishCommunityMemberJoinedSafe: jest.fn(),
  publishCommunityMemberKickedSafe: jest.fn(),
  publishCommunityMemberBannedSafe: jest.fn(),
  publishCommunityMemberUnbannedSafe: jest.fn(),
  publishCommunityMemberMutedSafe: jest.fn(),
  publishCommunityMemberUnmutedSafe: jest.fn(),
  publishCommunityMemberWarnedSafe: jest.fn(),
  publishCommunityMemberRoleChangedSafe: jest.fn(),
  publishCommunityMemberLeftSafe: jest.fn(),
  publishCommunityAdminTransferredSafe: jest.fn(),
  publishCommunityClosedSafe: jest.fn(),
  publishCommunityReopenedSafe: jest.fn(),
  publishCommunityDeletedSafe: jest.fn(),
  publishCommunityInviteAcceptedSafe: jest.fn(),
  publishCommunityInviteSentSafe: jest.fn(),
  publishCommunityJoinRequestApprovedSafe: jest.fn(),
  publishCommunityJoinRequestCancelledSafe: jest.fn(),
  publishCommunityJoinRequestedSafe: jest.fn(),
  publishCommunityJoinRequestRejectedSafe: jest.fn(),
  publishCommunityReportActionedSafe: jest.fn(),
  publishCommunityReportCreatedSafe: jest.fn(),
  publishCommunityLivestreamStartedSafe: jest.fn(),
  publishCommunityLivestreamEndedSafe: jest.fn(),
}));

// --- RabbitMQ: community chat publishers (key for system-message tests) ---
jest.mock("../../src/messaging/publish-community-chat.js", () => ({
  publishCommunitySystemMessageForChatSafe: jest.fn(),
  publishCommunitySystemMessageForChatAwaited: jest
    .fn()
    .mockResolvedValue(undefined),
  publishCommunityCreatedForChatSafe: jest.fn(),
  publishCommunityDeletedForChatSafe: jest.fn(),
  publishCommunityInviteLinkSharedForChatSafe: jest.fn(),
  publishCommunityMemberMuteSyncedForChatSafe: jest.fn(),
  publishCommunityMemberMuteRetractedForChatSafe: jest.fn(),
  publishCommunityStatusChangedForChatSafe: jest.fn(),
  publishCommunityVisibilityChangedForChatSafe: jest.fn(),
}));

// --- RabbitMQ: admin report publisher -------------------------------------
jest.mock("../../src/messaging/publish-admin-report.js", () => ({
  publishAdminReportIngestSafe: jest.fn(),
}));

// --- Community cache: no-op ------------------------------------------------
jest.mock("../../src/lib/community-cache.js", () => ({
  communityCache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    getType: jest.fn().mockResolvedValue(null),
    setType: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Community access policy: real read-only formulas (pure fn of the passed
// community row), no-op writable/joinable guards (most fixtures are ACTIVE
// anyway, so this preserves existing suites while giving close/reopen-focused
// suites correct isOwnerClosed/isEffectivelyClosed derivation) -------------
jest.mock("../../src/lib/community-access-policy.js", () => {
  const isOwnerClosed = (c) => (c?.status ?? "ACTIVE") === "CLOSED";
  const isPlatformSuspended = (c) => c?.moderationStatus === "SUSPENDED";
  const isEffectivelyClosed = (c) => isOwnerClosed(c) || isPlatformSuspended(c);
  const deriveStatus = (c) => (isOwnerClosed(c) ? "CLOSED" : "ACTIVE");
  const assertWritable = jest.fn();
  const assertJoinable = jest.fn();
  return {
    communityAccessPolicy: {
      isOwnerClosed: jest.fn(isOwnerClosed),
      isPlatformSuspended: jest.fn(isPlatformSuspended),
      isEffectivelyClosed: jest.fn(isEffectivelyClosed),
      deriveStatus: jest.fn(deriveStatus),
      assertWritable,
      assertJoinable,
    },
    isOwnerClosed: jest.fn(isOwnerClosed),
    isPlatformSuspended: jest.fn(isPlatformSuspended),
    isEffectivelyClosed: jest.fn(isEffectivelyClosed),
    deriveStatus: jest.fn(deriveStatus),
    assertWritable,
    assertJoinable,
    assertCommunityReadAccess: jest.fn().mockResolvedValue(undefined),
  };
});

// --- Invite rate limits: always pass in tests -----------------------------
jest.mock("../../src/lib/invite-rate-limit.js", () => ({
  assertInviteCreateRateLimit: jest.fn().mockResolvedValue(undefined),
  assertInviteBulkSendRateLimit: jest.fn().mockResolvedValue(undefined),
}));

// --- User gRPC client: mock user-service calls ----------------------------
jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn().mockResolvedValue(new Map()),
  fetchUserSnapshotHits: jest.fn().mockResolvedValue(new Map()),
  fetchAcceptedFriendIds: jest.fn().mockResolvedValue([]),
  fetchExistingUserIds: jest.fn().mockResolvedValue([]),
}));

// --- gRPC clients: prevent real channel creation --------------------------
jest.mock("../../src/grpc/chat.client.js", () => ({
  getChatClient: jest.fn().mockReturnValue({
    GetCommunityLastMessages: jest.fn(),
    GetCommunityMemberLastMessages: jest.fn(),
  }),
}));

jest.mock("../../src/grpc/stream.client.js", () => ({
  getStreamClient: jest.fn().mockReturnValue({
    getActiveCommunityIds: jest.fn().mockResolvedValue(new Set()),
    getActiveStreamCounts: jest.fn().mockResolvedValue(new Map()),
    getLiveStreamsByCommunity: jest.fn().mockResolvedValue([]),
    notifyMemberMuteStatus: jest.fn().mockResolvedValue(undefined),
    notifyMemberBanStatus: jest.fn().mockResolvedValue(undefined),
    forceEndStreamsByCreator: jest.fn().mockResolvedValue(undefined),
  }),
}));

// --- MinIO image/avatar services: return null presign URLs ----------------
jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveViewUrlForClient: jest.fn().mockResolvedValue(null),
    generateUploadUrl: jest.fn().mockResolvedValue({
      uploadUrl: "http://minio/test",
      objectKey: "test/key",
    }),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn().mockResolvedValue(null),
  },
}));

export {};

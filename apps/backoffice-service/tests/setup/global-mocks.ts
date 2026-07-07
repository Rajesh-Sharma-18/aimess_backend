/**
 * Global I/O-boundary mocks for backoffice-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch real
 * infrastructure or pull in ESM-only / native libs that CommonJS-mode Jest
 * cannot `require`. Per-test files may re-`jest.mock()` any of these to inject
 * richer behaviour for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 *
 * NOTE on the gRPC clients: each `src/grpc/*.client.ts` runs `import.meta.url`
 * AND `protoLoader.loadSync(...)` + `new ServiceCtor(...)` at module top level.
 * `import.meta` is ESM-only syntax that CJS-mode Jest cannot parse, so these
 * modules MUST be mocked or the app fails to import. We mock the thin client
 * objects the repository layer consumes.
 */

// --- Datastore: never open a real Postgres pool ---------------------------
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
}));

// --- Redis: never open a real connection ----------------------------------
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready" },
  connectBackofficeRedis: jest.fn(async () => undefined),
}));

// --- Object storage: avoid constructing a real S3/MinIO client at import --
jest.mock("../../src/config/storage.js", () => ({
  presignClient: {},
  mediaUrlStrategy: {
    resolveDownloadUrl: jest.fn(async () => null),
    toMediaObject: jest.fn(() => null),
  },
}));

// --- gRPC clients (ESM `import.meta` + live dial at import) ----------------
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: {
    getUserCounts: jest.fn(),
    getActiveUserCounts: jest.fn(),
    getActiveUserSeries: jest.fn(),
    adminListUsers: jest.fn(),
    adminGetUser: jest.fn(),
  },
  getUserCountsBreaker: { fire: jest.fn() },
  getActiveUserCountsBreaker: { fire: jest.fn() },
  getActiveUserSeriesBreaker: { fire: jest.fn() },
  adminListUsersBreaker: { fire: jest.fn() },
  adminGetUserBreaker: { fire: jest.fn() },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfilesByIds: jest.fn(async () => []),
    adminGetProfile: jest.fn(async () => null),
    adminSearchProfileIds: jest.fn(async () => []),
  },
  adminGetProfilesByIdsBreaker: { fire: jest.fn() },
  adminGetProfileBreaker: { fire: jest.fn() },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    adminGetCommunitiesByIds: jest.fn(async () => new Map()),
    adminListCommunities: jest.fn(async () => ({ communities: [], total: 0 })),
    adminGetMemberRoles: jest.fn(async () => new Map()),
    adminSearchCommunityIds: jest.fn(async () => []),
    adminListCategories: jest.fn(async () => ({ categories: [], total: 0 })),
  },
}));
// stream.client runs `import.meta.url` + a live gRPC dial at import; it is now
// pulled into the app graph by the livestream repository, so it must be mocked.
jest.mock("../../src/grpc/stream.client.js", () => ({
  streamClient: {
    adminListStreams: jest.fn(async () => ({ streams: [], total: 0 })),
    adminGetStream: jest.fn(async () => null),
    adminForceEnd: jest.fn(async () => ({ success: true, status: "ENDED" })),
    getStreamStats: jest.fn(async () => ({ found: false })),
    adminUpdateThumbnail: jest.fn(async () => undefined),
    adminListViewerSessions: jest.fn(async () => ({ sessions: [], total: 0 })),
  },
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: {},
}));

// --- RabbitMQ publishers: fire-and-forget no-ops --------------------------
jest.mock("../../src/messaging/publish-admin-user-event.js", () => ({
  publishUserBannedSafe: jest.fn(),
  publishUserUnbannedSafe: jest.fn(),
  publishUserSuspendedSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-admin-password-reset-otp.js", () => ({
  publishAdminPasswordResetOtp: jest.fn(async () => undefined),
  publishAdminPasswordResetOtpSafe: jest.fn(),
}));

// --- Admin session / permission caches (Redis-backed). Resolve "active" so
//     authenticated admin routes are reachable with a token minted by
//     tests/helpers/auth.ts. Permission set is empty by default; specs that
//     hit a permission-gated route re-mock with the keys they need.
jest.mock("../../src/lib/admin-session-cache.js", () => ({
  isAdminSessionActiveForRequest: jest.fn(async () => true),
  markAdminSessionActive: jest.fn(async () => undefined),
  markAdminSessionRevoked: jest.fn(async () => undefined),
  markAdminSessionsRevoked: jest.fn(async () => undefined),
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));

export {};

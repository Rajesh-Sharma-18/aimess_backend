/**
 * Global I/O-boundary mocks for user-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch real
 * infrastructure or pull in ESM-only / native libs that CommonJS-mode Jest
 * cannot `require` (gRPC proto loading via `import.meta`, MinIO/S3, ioredis).
 * Per-test files may re-`jest.mock()` any of these to inject richer behaviour
 * for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 */

// --- Datastore: never open a real Postgres pool ---------------------------
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
}));

// --- Redis: never open a real connection. Cache treated as not-ready so the
//     cache-first read paths fall straight through to the (mocked) repos. -----
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready" },
  isUserCacheReady: jest.fn(() => false),
  connectUserRedis: jest.fn(async () => undefined),
  disableUserCache: jest.fn(),
}));

// --- Session-active gate: treat any well-formed JWT's session as live, so
//     authenticated routes are reachable with a token minted by tests/helpers.
jest.mock("../../src/lib/session-active-cache.js", () => ({
  isSessionActiveForRequest: jest.fn(async () => true),
}));

// --- auth-service gRPC client: the real module runs `protoLoader.loadSync`
//     against a path derived from `import.meta.url` at import time (breaks
//     under CJS-mode Jest) and pulls in native @grpc/grpc-js. Stub it. --------
jest.mock("../../src/grpc/auth.client.js", () => ({
  authGrpcClient: {
    getAccountSummary: jest.fn(async () => ({
      userId: "",
      account: "",
      email: "",
      emailVerified: false,
      hasPassword: false,
      primaryAccount: "",
      providers: [],
    })),
  },
  getAccountSummaryBreaker: { fire: jest.fn(), on: jest.fn() },
}));

// --- chat-service gRPC client: the real module runs `protoLoader.loadSync`
//     against a path derived from `import.meta.url` at import time (breaks
//     under CJS-mode Jest) and pulls in native @grpc/grpc-js. Stub it. --------
jest.mock("../../src/grpc/messaging.client.js", () => ({
  messagingGrpcClient: {
    resolvePrivateRooms: jest.fn(async () => []),
    listPrivateRoomPeers: jest.fn(async () => []),
    listActiveGroups: jest.fn(async () => []),
    listOtherGroups: jest.fn(async () => []),
    getGroupsByIds: jest.fn(async () => []),
    getOrCreatePrivateRooms: jest.fn(async () => []),
    getGroupMemberIds: jest.fn(async () => []),
  },
}));

// --- community-service gRPC client: same story as messaging.client above
//     (`import.meta.url` at module scope + native @grpc/grpc-js). Reached from
//     user discovery, which subtracts a community's roster from the "Add
//     Members" picker. Empty roster = exclude nobody, the module's own
//     fail-open value. ---------------------------------------------------------
jest.mock("../../src/grpc/community.client.js", () => ({
  communityGrpcClient: {
    getActiveMemberIds: jest.fn(async () => []),
  },
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

export {};

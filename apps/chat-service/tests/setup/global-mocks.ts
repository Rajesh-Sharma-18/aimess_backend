/**
 * Global I/O-boundary mocks for chat-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch real
 * infrastructure or pull in ESM-only native libs that CommonJS-mode Jest cannot
 * `require`. Per-test files may re-`jest.mock()` any of these to inject richer
 * behaviour for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 *
 * Paths are relative to THIS file (tests/setup/), referencing the seams the way
 * the SOURCE imports them.
 */

// --- nanoid v5 is ESM-only and (under pnpm's nested layout) is NOT matched by
//     the preset's transformIgnorePatterns, so CJS-mode Jest cannot parse it.
//     src/lib/room-id.ts imports it; stub it with a deterministic id generator
//     so the REAL room-id helpers (generateRoomId/buildParticipantsKey) run. ---
jest.mock("nanoid", () => ({
  nanoid: jest.fn((size = 21) => "a".repeat(size)),
}));

// --- Datastore: never construct a real Prisma/Mongo client at import time ----
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
}));

// --- Redis (ioredis is ESM-only under CJS Jest). Stub a client surface rich
//     enough for the rate-limit middleware (multi()/exec()) and the health
//     debug route (get/del). Status "ready" so isChatCacheReady() is truthy. ---
jest.mock("../../src/config/redis.js", () => {
  const noopMulti = {
    zremrangebyscore: jest.fn().mockReturnThis(),
    zadd: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    pexpire: jest.fn().mockReturnThis(),
    exec: jest.fn(async () => null),
  };
  const redis = {
    status: "ready",
    multi: jest.fn(() => noopMulti),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 0),
    zrange: jest.fn(async () => []),
    on: jest.fn(),
    quit: jest.fn(async () => undefined),
  };
  return {
    redis,
    isChatCacheReady: jest.fn(() => true),
    connectChatRedis: jest.fn(async () => undefined),
    disableChatCache: jest.fn(),
    createRedisSubClient: jest.fn(() => ({ ...redis })),
  };
});

// --- Object storage wrapper (@aimess/storage pulls in the MinIO/S3 client).
//     Mock the thin service-config module so importing it loads no native lib. -
jest.mock("../../src/config/storage.js", () => ({
  storageClient: {},
  presignClient: {},
  mediaUrlStrategy: {},
}));

// --- gRPC peer access (pulls @grpc/grpc-js + proto loaders). The health debug
//     route imports this lib; mocking it keeps every grpc/*.client.js out of the
//     module graph for app-boot tests. -------------------------------------- --
jest.mock("../../src/lib/user-service-client.js", () => ({
  fetchUsersBatch: jest.fn(async () => []),
  fetchAccountsBatch: jest.fn(async () => []),
}));

export {};

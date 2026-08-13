/**
 * Global I/O-boundary mocks for media-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). Prevents the real MinIO/S3 SDK, Redis, and
 * gRPC proto-loader from running under CJS-mode Jest.
 */

// --- MinIO / S3 storage clients -------------------------------------------
jest.mock("../../src/config/storage.js", () => ({
  storageClient: {},
  presignClient: {},
  mediaUrlStrategy: {
    resolveDownloadUrl: jest.fn(async () => ({
      url: "https://minio.test/presigned-get",
      expiresIn: 3600,
    })),
    toViewUrl: jest.fn(async () => null),
    buildMediaObject: jest.fn(async () => null),
  },
}));

// --- MediaFile registry repository (prevents live Mongo/Prisma in tests) ---
jest.mock("../../src/repositories/media-file.repository.js", () => ({
  mediaFileRepository: {
    register: jest.fn(async () => ({ id: "mock-media-id" })),
    findByObjectKey: jest.fn(async () => null),
    findByObjectKeys: jest.fn(async () => []),
    setScanStatus: jest.fn(async () => undefined),
    setUsage: jest.fn(async () => undefined),
    setVerifiedSize: jest.fn(async () => undefined),
  },
}));

// --- chat-service gRPC membership client (no live gRPC in tests) -----------
// Stable checkMediaAccess fn (same instance across getChatAccessClient() calls)
// so a test can override the verdict via getChatAccessClient().checkMediaAccess.
jest.mock("../../src/grpc/clients/chat-access.client.js", () => {
  const checkMediaAccess = jest.fn(async () => true); // default: allow
  return { getChatAccessClient: jest.fn(() => ({ checkMediaAccess })) };
});

// --- Redis client (prevents live Redis connection in tests) ----------------
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    publish: jest.fn(async () => 0),
    connect: jest.fn(async () => undefined),
  },
  connectMediaRedis: jest.fn(async () => undefined),
}));

// --- Scanner (no-op in tests; scan-status gated separately) ----------------
jest.mock("../../src/lib/scanner.js", () => ({
  mediaScanner: { scan: jest.fn(async () => ({ status: "SKIPPED" })) },
  scanStatusStore: {
    // Default: return CLEAN so download tests pass without confirming first.
    // Individual tests that need to test gating override this per-test.
    get: jest.fn(async () => "CLEAN"),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  },
  createScanner: jest.fn(() => ({
    scan: jest.fn(async () => ({ status: "SKIPPED" })),
  })),
  NoopMediaScanner: jest.fn().mockImplementation(() => ({
    scan: jest.fn(async () => ({ status: "SKIPPED" })),
  })),
  enqueueScan: jest.fn(async () => true),
  runScanAndPersist: jest.fn(async () => "CLEAN"),
  publishScanResult: jest.fn(() => undefined),
  startScanWorker: jest.fn(() => undefined),
  getScanQueue: jest.fn(() => ({
    add: jest.fn(async () => ({})),
    close: jest.fn(async () => undefined),
    process: jest.fn(),
    on: jest.fn(),
  })),
}));

export {};

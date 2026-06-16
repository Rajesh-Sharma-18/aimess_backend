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

// --- Redis client (prevents live Redis connection in tests) ----------------
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
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
  startScanWorker: jest.fn(() => undefined),
  getScanQueue: jest.fn(() => ({
    add: jest.fn(async () => ({})),
    close: jest.fn(async () => undefined),
    process: jest.fn(),
    on: jest.fn(),
  })),
}));

export {};

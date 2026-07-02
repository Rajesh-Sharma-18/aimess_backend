/**
 * Global I/O-boundary mocks for stream-service (Jest setupFilesAfterEnv).
 *
 * These tests construct `LivestreamViewerSessionRepository` /
 * `LivestreamService` directly with manually-faked constructor args (Prisma,
 * redis, repos), so no `jest.mock()` of the real I/O modules is needed for
 * those units. This file only silences the logger so suite stdout stays clean.
 */
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

// --- user gRPC client: default constructor param on LivestreamService/
// LivestreamCommentService. The real module uses top-level `import.meta.url`
// (ESM-only proto-path resolution), which CJS-mode ts-jest cannot parse —
// mock it so importing the service class doesn't pull in the real client.
jest.mock("../../src/grpc/user.client.js", () => ({
  userGrpcClient: {
    bulkGetUserSnapshots: jest.fn().mockResolvedValue([]),
  },
}));

export {};

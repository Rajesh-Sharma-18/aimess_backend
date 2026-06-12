/**
 * Global I/O-boundary mocks for media-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). Prevents the real MinIO/S3 SDK and gRPC
 * proto-loader from running under CJS-mode Jest.
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

export {};

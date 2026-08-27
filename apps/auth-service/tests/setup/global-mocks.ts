/**
 * Global I/O-boundary mocks for auth-service, applied to every test file
 * (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch real
 * infrastructure or pull in ESM-only native libs that CommonJS-mode Jest cannot
 * `require`. Per-test files may re-`jest.mock()` any of these to inject richer
 * behaviour for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 */

// --- Datastore: never open a real Postgres pool ---------------------------
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
}));

// --- Redis: never open a real connection ----------------------------------
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready", publish: jest.fn(async () => 0) },
  connectAuthRedis: jest.fn(async () => undefined),
}));

// --- Session-active gate: treat any well-formed JWT's session as live, so
//     authenticated routes are reachable with a token minted by tests/helpers.
jest.mock("../../src/lib/session-active-cache.js", () => ({
  isSessionActiveForRequest: jest.fn(async () => true),
  markSessionActive: jest.fn(async () => undefined),
  markSessionRevoked: jest.fn(async () => undefined),
  markSessionsRevoked: jest.fn(async () => undefined),
}));

// --- RabbitMQ publisher: fire-and-forget no-op ----------------------------
jest.mock("../../src/messaging/publish-user-created.js", () => ({
  publishUserCreated: jest.fn(async () => undefined),
  publishUserCreatedSafe: jest.fn(),
}));

// --- notifications-service gRPC client: the real module resolves its proto
//     path from `import.meta.url` at import time (unparsable in CJS-mode Jest)
//     and pulls in native @grpc/grpc-js. Stub it, same as user-service does.
jest.mock("../../src/grpc/notification.client.js", () => ({
  recordSessionActionSafe: jest.fn(),
}));

// --- backoffice-service gRPC client: same import.meta/native-module problem.
//     Defaults to "no admin owns this email" so existing email specs keep
//     exercising the AuthUser-side rules; specs that care re-mock it.
jest.mock("../../src/grpc/backoffice.client.js", () => ({
  isAdminEmailTaken: jest.fn(async () => false),
}));

// --- External identity verifiers (pull in ESM-only google-auth-library /
//     jose). Empty module by default; social-login specs re-mock with fns.
jest.mock("../../src/lib/google-id-token.js", () => ({
  verifyGoogleIdToken: jest.fn(),
}));
jest.mock("../../src/lib/apple-id-token.js", () => ({
  verifyAppleIdToken: jest.fn(),
}));

export {};

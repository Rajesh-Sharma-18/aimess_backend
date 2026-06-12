/**
 * Global I/O-boundary mocks for api-gateway, applied to every test file
 * (Jest `setupFilesAfterEnv`).
 *
 * The gateway's `src/app.ts` (`createApp(messagingClient)`) is unusually
 * self-contained for testing: it imports NO Prisma, NO Redis client, NO gRPC
 * RUNTIME. The real gRPC messaging client (`@grpc/grpc-js` + `@grpc/proto-loader`
 * + `import.meta`) is constructed only in `src/server.ts` — never in the app
 * graph — so tests simply pass a mock `MessagingClient` object into `createApp`.
 * Likewise Socket.IO + its Redis adapter live in `src/sockets/*`, imported only
 * by `server.ts`.
 *
 * Two thin modules inside the `createApp` graph DO evaluate `import.meta.url` at
 * top level (ESM-only, unparseable by CommonJS-mode Jest) — they are mocked
 * below so the app loads:
 *   - `src/docs/asyncapi.js`            (resolves the AsyncAPI spec path)
 *   - `src/app-version/app-version.store.js` (resolves the default config path)
 *
 * The shared Winston logger is also stubbed so suite stdout stays clean.
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 */

// --- AsyncAPI docs: top-level `import.meta.url` (ESM-only). No-op setup. ----
jest.mock("../../src/docs/asyncapi.js", () => ({
  setupAsyncApiDocs: jest.fn(),
}));

// --- App-version store: top-level `import.meta.url` (ESM-only). The factory's
//     `.get()` resolves the in-memory defaults passed by app-version/index.ts,
//     so /app-version/check works without ever touching the filesystem. -------
jest.mock("../../src/app-version/app-version.store.js", () => ({
  createAppVersionStore: (opts: { defaults: unknown }) => ({
    get: jest.fn(async () => opts.defaults),
  }),
  resolveDefaultConfigPath: jest.fn(() => "/virtual/app-versions.json"),
}));

// --- Shared logger: swallow output so test stdout stays clean --------------
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
  return {
    logger,
    createChildLogger: () => logger,
  };
});

export {};

/**
 * Shared Jest preset for every AIMess service.
 *
 * Strategy: "integration tests with mocked deps".
 *   - supertest drives each service's real Express `app` (routes, middleware,
 *     validation, controllers, services all execute for real).
 *   - Only the I/O boundary is mocked (Prisma repositories, Redis, RabbitMQ
 *     publishers, gRPC clients, external OAuth/JWKS verifiers).
 *
 * Module strategy: ts-jest transpiles TypeScript (including the repo's
 * `.js`-suffixed ESM import specifiers) down to CommonJS so classic, reliable
 * `jest.mock()` hoisting works. Workspace `@aimess/*` packages and relative
 * `.js` specifiers are remapped to their TypeScript sources, so the suite needs
 * no prior `pnpm build:packages` and can never run against a stale `dist/`.
 *
 * Each service's `jest.config.cjs` does:  `module.exports = require(this)`
 * (optionally spreading extra `setupFilesAfterEnv` / `moduleNameMapper`).
 * `<rootDir>` therefore resolves to the individual service directory.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: "service",
  // Resolve to an absolute path instead of the bare string "node". In this
  // pnpm workspace, media-service still pins jest@29 (and its own
  // jest-environment-node@29.7.0); Jest's dynamic by-name resolution for the
  // "node" testEnvironment can walk up into pnpm's shared virtual-store
  // node_modules and grab THAT older copy instead of the jest@30 one this
  // preset needs, producing a jest-runtime/jest-mock version mismatch
  // (`clearMocksOnScope is not a function`). Resolving here, relative to this
  // file, is deterministic regardless of that ambiguity.
  testEnvironment: require.resolve("jest-environment-node"),
  roots: ["<rootDir>/tests"],
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        // Transpile-only: a test must never fail because a *mock object*
        // doesn't satisfy the production type. Type safety is enforced by the
        // service's own `tsc --noEmit`, not by the test runner.
        diagnostics: false,
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          verbatimModuleSyntax: false,
          isolatedModules: true,
          target: "ES2022",
          skipLibCheck: true,
          resolveJsonModule: true,
          useDefineForClassFields: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Prisma 7's generated `client.js` uses top-level `import.meta` (ESM-only)
    // which CJS-mode Jest cannot parse. Redirect every service's generated
    // client to a universal stub. MUST precede the generic ".js"-strip rule.
    "(?:\\.{1,2}/)+generated/prisma/client(?:\\.js)?$":
      "<rootDir>/../../tooling/jest/prisma-client.stub.cjs",
    // @aimess/<pkg> → that package's TypeScript source entrypoint.
    "^@aimess/([^/]+)$": "<rootDir>/../../packages/$1/src/index.ts",
    // @aimess/<pkg>/<subpath> → source subpath (rare, but supported).
    "^@aimess/([^/]+)/(.*)$": "<rootDir>/../../packages/$1/src/$2",
    // Strip the ESM ".js" extension from relative imports so the resolver finds
    // the underlying ".ts" source (covers app code AND the Prisma client).
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // node_modules stays untransformed EXCEPT the rare ESM-only deps that some
  // services import directly. Extend per service if a new ESM dep appears.
  transformIgnorePatterns: ["/node_modules/(?!(nanoid|uuid|jose)/)"],
  clearMocks: true,
  restoreMocks: true,
  setupFiles: ["<rootDir>/tests/setup/env.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup/global-mocks.ts"],
  testTimeout: 20000,
  // Surface accidental real network/socket handles instead of hanging CI.
  detectOpenHandles: false,
  forceExit: true,
};

/**
 * Jest project for the shared packages.
 *
 * The root config listed only the nine app projects, so nothing under
 * `packages/**` was ever executed — the error hierarchy and the response
 * envelope every service depends on had no assertions at all, and a change to
 * either could only be caught indirectly, by whichever service test happened to
 * assert on a message string.
 *
 * This does NOT reuse tooling/jest/jest.preset.cjs wholesale: the preset points
 * `roots`, `setupFiles` and `setupFilesAfterEach` at `<rootDir>/tests/setup/*`,
 * which exist per-service and not here. Only the transform and the workspace
 * module mapping are shared.
 *
 * Run:  node node_modules/jest/bin/jest.js --selectProjects packages
 */
const preset = require("../tooling/jest/jest.preset.cjs");

/** @type {import('jest').Config} */
module.exports = {
  displayName: "packages",
  rootDir: ".",
  testEnvironment: preset.testEnvironment,
  roots: ["<rootDir>"],
  testMatch: ["<rootDir>/*/tests/**/*.test.ts"],
  // `grpc-utils/tests/service-auth.test.ts` is a top-level `node:assert` script
  // run through tsx by that package's own `test` script — its header says so
  // explicitly. It only shares the `.test.ts` suffix; Jest would collect it and
  // fail with "must contain at least one test". Left as-is deliberately rather
  // than converted, since it is exercised by `pnpm --filter @aimess/grpc-utils test`.
  testPathIgnorePatterns: ["<rootDir>/grpc-utils/tests/service-auth\\.test\\.ts$"],
  moduleFileExtensions: preset.moduleFileExtensions,
  transform: preset.transform,
  moduleNameMapper: {
    "^@aimess/([^/]+)$": "<rootDir>/$1/src/index.ts",
    "^@aimess/([^/]+)/(.*)$": "<rootDir>/$1/src/$2",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: preset.transformIgnorePatterns,
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10000,
};

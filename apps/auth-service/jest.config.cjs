/**
 * auth-service Jest config — see tooling/jest/jest.preset.cjs for strategy.
 * Run:  pnpm exec jest --config apps/auth-service/jest.config.cjs
 *   or: pnpm --filter @aimess/auth-service test
 */
const preset = require("../../tooling/jest/jest.preset.cjs");

/** @type {import('jest').Config} */
module.exports = {
  ...preset,
  displayName: "auth-service",
  rootDir: ".",
};

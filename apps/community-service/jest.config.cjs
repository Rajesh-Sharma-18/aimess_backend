/**
 * community-service Jest config — see tooling/jest/jest.preset.cjs for strategy.
 * Run:  node node_modules/jest/bin/jest.js --config apps/community-service/jest.config.cjs
 */
const preset = require("../../tooling/jest/jest.preset.cjs");

/** @type {import('jest').Config} */
module.exports = {
  ...preset,
  displayName: "community-service",
  rootDir: ".",
};

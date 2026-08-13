/**
 * Root Jest config — runs every service's suite in one process via projects.
 *
 *   node node_modules/jest/bin/jest.js                 # all services
 *   node node_modules/jest/bin/jest.js --selectProjects auth-service
 *
 * Each service also runs standalone via its own apps/<svc>/jest.config.cjs
 * (that is what `pnpm --filter @aimess/<svc> test` and `turbo run test` invoke).
 * Strategy + harness details: see tooling/jest/jest.preset.cjs and tests/README.md.
 */
module.exports = {
  projects: [
    "<rootDir>/apps/auth-service/jest.config.cjs",
    "<rootDir>/apps/user-service/jest.config.cjs",
    "<rootDir>/apps/community-service/jest.config.cjs",
    "<rootDir>/apps/chat-service/jest.config.cjs",
    "<rootDir>/apps/notifications-service/jest.config.cjs",
    "<rootDir>/apps/backoffice-service/jest.config.cjs",
    "<rootDir>/apps/api-gateway/jest.config.cjs",
    "<rootDir>/apps/media-service/jest.config.cjs",
    "<rootDir>/apps/stream-service/jest.config.cjs",
    // Shared packages had no project at all, so the error hierarchy and the
    // response envelope every service depends on were never executed.
    "<rootDir>/packages/jest.config.cjs",
  ],
};

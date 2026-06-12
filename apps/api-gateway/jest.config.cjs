/**
 * api-gateway Jest config — see tooling/jest/jest.preset.cjs for strategy.
 * Run:  node node_modules/jest/bin/jest.js --config apps/api-gateway/jest.config.cjs
 */
const preset = require("../../tooling/jest/jest.preset.cjs");

/** @type {import('jest').Config} */
module.exports = {
  ...preset,
  displayName: "api-gateway",
  rootDir: ".",
  // The gateway imports `uuid@14` (pure ESM, `"type": "module"`, no CJS build)
  // in `src/middleware/request-id.ts`. The shared preset's `transform` only
  // compiles `.tsx?` files, so uuid's `.js` source is never transpiled and
  // CommonJS-mode Jest chokes on its top-level `export`. Redirect the bare
  // `uuid` specifier to a tiny CJS stub (`crypto.randomUUID`-backed v4) — the
  // gateway only uses `uuid.v4()` for an opaque request id, so behaviour is
  // identical. Preset mappings (prisma stub, @aimess/*, ".js" strip) preserved.
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    "^uuid$": "<rootDir>/tests/stubs/uuid.cjs",
  },
};

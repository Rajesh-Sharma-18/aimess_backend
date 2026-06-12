/**
 * CommonJS stub for `uuid` (v14, which ships ESM-only with `"type": "module"`
 * and no CJS build). The shared preset's `transform` only compiles `.tsx?`
 * files, so uuid's `.js` source is never transpiled and CommonJS-mode Jest
 * chokes on its top-level `export`. The gateway only uses `uuid.v4()` to mint an
 * opaque `x-request-id`, so a faithful RFC-4122 v4 generator is all that's
 * needed — no behavioural difference for any route under test.
 *
 * Wired via `moduleNameMapper` in `apps/api-gateway/jest.config.cjs`.
 */
const { randomUUID } = require("node:crypto");

function v4() {
  return randomUUID();
}

module.exports = { v4, default: { v4 } };

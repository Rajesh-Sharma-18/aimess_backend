/**
 * Batched lint-staged tasks for Windows (avoids "command line too long").
 * lint-staged v17 requires functions to return shell command strings.
 */
const BATCH_SIZE = 40;

/** @param {string[]} files */
function chunk(files) {
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

/**
 * Type-aware ESLint (`parserOptions.project`) loads a full TS program per
 * tsconfig project a batch touches; a wide cross-service commit can exhaust
 * Node's default heap and crash with "Last few GCs". Raise the old-space cap.
 *
 * @param {string} script @param {string[]} files
 */
function nodeTask(script, files) {
  const quoted = files.map((file) => JSON.stringify(file)).join(" ");
  return `node --max-old-space-size=8192 ${script} ${quoted}`;
}

/** @type {import('lint-staged').Configuration} */
export default {
  "*.{ts,tsx,js,jsx}": (files) =>
    chunk(files).flatMap((batch) => [
      nodeTask("scripts/lint-staged-eslint.mjs", batch),
      nodeTask("scripts/lint-staged-prettier.mjs", batch),
    ]),
  "*.{json,md,yml,yaml}": (files) =>
    chunk(files).map((batch) =>
      nodeTask("scripts/lint-staged-prettier.mjs", batch)
    ),
};

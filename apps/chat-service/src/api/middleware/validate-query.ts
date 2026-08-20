/**
 * Validates `req.query` against a Zod schema before controllers run.
 *
 * Re-exported from `@aimess/utils` so all five services answer an invalid
 * request identically — same status, same code, and the same field-level
 * `error.details` a form needs to mark the offending input. Kept as a file so
 * every existing route import is unchanged.
 */
export { validateQuery } from "@aimess/utils";

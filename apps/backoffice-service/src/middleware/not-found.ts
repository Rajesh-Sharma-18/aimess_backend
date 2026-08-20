/**
 * Terminal 404 — any unmatched route returns the shared JSON envelope, never
 * Express's HTML `finalhandler` body. Re-exported from `@aimess/utils` so all
 * nine services answer identically.
 */
export { notFoundHandler as notFound } from "@aimess/utils";

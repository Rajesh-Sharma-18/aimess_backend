import type { Request } from "express";

/**
 * Shared response-envelope `meta` helper used by every admin controller.
 * Extracted from the byte-identical copies that lived in
 * users.controller.ts and moderation.controller.ts (DRY).
 */

/** Pull the inbound request id (if any) for the response `meta`. */
export function requestIdOf(req: Request): string | undefined {
  const raw = req.headers["x-request-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id?.trim() ? id : undefined;
}

/** Build the standard response `meta` envelope shared by every handler. */
export function buildMeta(req: Request): {
  requestId: string | null;
  generatedAt: string;
} {
  return {
    requestId: requestIdOf(req) ?? null,
    generatedAt: new Date().toISOString(),
  };
}

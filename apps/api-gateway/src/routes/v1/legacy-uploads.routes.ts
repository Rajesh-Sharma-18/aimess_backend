import express, { Router, type IRouter } from "express";
import type { Request, Response } from "express";

import { asyncHandler, sendApiError } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";
import { logger } from "@aimess/logger";

/**
 * Stable public alias for avatar upload-URL issuance.
 *
 *   POST /api/v1/users/uploads/url   (request: { type: "AVATAR", ... })
 *     → forwarded to the centralized media-service
 *   POST /api/v1/media/upload-url    (request: { category: "USER_AVATAR", ... })
 *
 * Upload-URL issuance is centralized in the media-service; this route keeps the
 * `/users/uploads/url` contract working without duplicating any logic. The only
 * transform is the request field rename (`type: "AVATAR"` → `category:
 * "USER_AVATAR"`). media-service performs JWT auth (deriving `ownerId` from the
 * token) and returns the same response shape, which is relayed verbatim.
 */
export function createLegacyUploadsRouter(mediaServiceUrl: string): IRouter {
  const router = Router();
  const upstreamUrl = `${mediaServiceUrl.replace(/\/$/, "")}/api/v1/media/upload-url`;

  router.post(
    "/users/uploads/url",
    express.json({ limit: "1mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        type?: unknown;
        contentType?: unknown;
        contentLength?: unknown;
      };

      // Contract: `type` must be the literal "AVATAR".
      // Error envelope matches the platform shape `{ success:false, message }`.
      if (body.type !== "AVATAR") {
        return sendApiError(req, res, {
          statusCode: HTTP_STATUS.BAD_REQUEST,
          code: "VALIDATION_FAILED",
          fallbackMessage: 'Invalid upload type. Only "AVATAR" is supported.',
          details: { type: ['Only "AVATAR" is supported.'] },
        });
      }

      // Forward to media-service, renaming type→category. media-service runs
      // its own JWT auth (ownerId = token userId) and validates contentType /
      // contentLength, so we relay its status + body unchanged.
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof req.headers.authorization === "string"
              ? { Authorization: req.headers.authorization }
              : {}),
            ...(typeof req.headers["x-lang"] === "string"
              ? { "x-lang": req.headers["x-lang"] }
              : {}),
          },
          body: JSON.stringify({
            category: "USER_AVATAR",
            contentType: body.contentType,
            contentLength: body.contentLength,
          }),
        });
      } catch (error) {
        logger.error("/users/uploads/url → media-service forward failed");
        logger.error(error);
        return sendApiError(req, res, {
          statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
          messageKey: "SERVICE_UNAVAILABLE",
          retryAfterSec: 5,
        });
      }

      const payload = await upstream.text();
      return res.status(upstream.status).type("application/json").send(payload);
    })
  );

  return router;
}

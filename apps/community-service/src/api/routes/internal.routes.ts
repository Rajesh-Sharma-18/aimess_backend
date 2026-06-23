import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { communityService } from "../../services/community.service.js";
import { env } from "../../config/env.js";
import { validateParams } from "../middleware/validate-params.js";
import {
  handleParamsSchema,
  type HandleParams,
} from "../validators/community.validator.js";

/**
 * Guard for unauthenticated service-to-service routes. Requires a constant-ish
 * `x-internal-secret` header matching `INTERNAL_SHARED_SECRET`. When the secret
 * is unconfigured the whole surface is treated as disabled (404) so it can never
 * be reached accidentally in environments that don't use it.
 */
function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = env.INTERNAL_SHARED_SECRET;
  const provided = req.header("x-internal-secret");
  if (!expected || provided !== expected) {
    res.status(HTTP_STATUS.NOT_FOUND).end();
    return;
  }
  next();
}

export const internalRoutes: IRouter = Router();

internalRoutes.use(requireInternalSecret);

/**
 * `GET /internal/communities/by-handle/:handle/card` — PUBLIC-only metadata card
 * for the api-gateway's server-rendered link preview (OG unfurl). Never reveals
 * a private/suspended community (404). Not exposed via the gateway's /api proxy.
 */
internalRoutes.get(
  "/communities/by-handle/:handle/card",
  validateParams(handleParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { handle } = req.params as unknown as HandleParams;
    const card = await communityService.getPublicCard(handle);
    return res.status(HTTP_STATUS.OK).json(new ApiResponse(card, "OK"));
  })
);

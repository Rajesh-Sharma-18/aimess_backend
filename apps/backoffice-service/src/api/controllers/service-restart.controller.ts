import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { getRequestContext } from "../../lib/request-context.js";
import { requestIdOf } from "../../lib/response-meta.js";
import { serviceRestartService } from "../../services/index.js";

/**
 * GET /v1/system-health/restarts — restart availability, advice and the latest
 * operation per service. Polled by the panel while a restart runs.
 */
export const listServiceRestarts: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await serviceRestartService.listRestarts();
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(data, t("ADMIN_SERVICE_RESTARTS_FETCHED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/system-health/services/:serviceKey/restart — 202 once the restart is
 * accepted. The body is ignored: the allowlisted key in the path is the only
 * input. The outcome arrives later through the list endpoint.
 */
export const restartService: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { serviceKey } = req.params as { serviceKey: string };
      const operation = await serviceRestartService.startRestart(
        serviceKey,
        req.admin!.id,
        { ...getRequestContext(req), requestId: requestIdOf(req) ?? null }
      );
      res
        .status(202)
        .json(
          new ApiResponse({ operation }, t("ADMIN_SERVICE_RESTART_ACCEPTED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

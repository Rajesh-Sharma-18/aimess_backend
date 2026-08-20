import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import {
  callAnalyticsService,
  dashboardService,
} from "../../services/index.js";
import type {
  CallAnalyticsQueryInput,
  DashboardChartsQueryInput,
} from "../validators/index.js";
import { HTTP_STATUS, t } from "@aimess/constants";

/**
 * GET /v1/dashboard/overview — stat cards only (users/active/communities/
 * groups), live gRPC-aggregated with 0 fallback on upstream failure.
 */
export const getDashboardOverview: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await dashboardService.getOverview();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            data,
            t("ADMIN_DASHBOARD_OVERVIEW_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/dashboard/charts — active-vs-churned series (filtered by
 * `?period=daily|weekly|monthly`) + communities/groups donut.
 */
export const getDashboardCharts: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { period } = req.query as unknown as DashboardChartsQueryInput;
      const data = await dashboardService.getCharts(period);
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(data, t("ADMIN_DASHBOARD_CHARTS_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/dashboard/service-status — opossum-derived per-service health panel.
 */
export const getDashboardServiceStatus: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const data = await dashboardService.getServiceStatus();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            data,
            t("ADMIN_DASHBOARD_SERVICE_STATUS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/dashboard/calls — call analytics over an optional YYYY-MM-DD range
 * (totals, audio/video split, avg duration, missed rate, peak hours) plus live
 * active/ringing counters. `data.available === false` means chat-service was
 * unreachable and the figures are placeholders.
 */
export const getDashboardCallAnalytics: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { fromDate, toDate } =
        req.query as unknown as CallAnalyticsQueryInput;
      const data = await callAnalyticsService.getAnalytics({
        fromDate,
        toDate,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            data,
            t("ADMIN_DASHBOARD_CALL_ANALYTICS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

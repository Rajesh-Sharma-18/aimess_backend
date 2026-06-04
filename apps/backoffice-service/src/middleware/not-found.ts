import type { RequestHandler } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";

/** Terminal 404 — any unmatched route returns a JSON envelope (never HTML). */
export const notFound: RequestHandler = (req, res) => {
  res
    .status(HTTP_STATUS.NOT_FOUND)
    .json({ success: false, message: t("ROUTE_NOT_FOUND", req.locale) });
};

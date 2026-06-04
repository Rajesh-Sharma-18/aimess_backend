import type { RequestHandler } from "express";

import { adminAuthService } from "../../services/index.js";

/** GET /v1/me — current admin profile + resolved permissions. */
export const getMe: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const profile = await adminAuthService.getMe(req.admin!.id);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  })();
};

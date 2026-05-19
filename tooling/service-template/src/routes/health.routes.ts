import { Router } from "express";

import { SERVICE_SLUG, SERVICE_TITLE } from "../constants/index.js";
import { env } from "../config/env.js";

export const healthRouter: Router = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    service: SERVICE_SLUG,
    title: SERVICE_TITLE,
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

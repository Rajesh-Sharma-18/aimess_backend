import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

import { createRoutes, type Controllers } from "./api/routes/index.js";
import { errorHandler } from "./middleware/error-handler.js";

export function createApp(controllers: Controllers): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(localeMiddleware);

  // Mount all chat routes
  app.use(createRoutes(controllers));

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}

import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { localeMiddleware } from "@aimess/utils";

import { accountRoutes } from "./api/routes/account.routes.js";
import { accountDeletionRoutes } from "./api/routes/account-deletion.routes.js";
import { authRoutes } from "./api/routes/auth.routes.js";
import { changeEmailRoutes } from "./api/routes/change-email.routes.js";
import { changePasswordRoutes } from "./api/routes/change-password.routes.js";
import { deviceLinkRoutes } from "./api/routes/device-link.routes.js";
import { emailLinkRoutes } from "./api/routes/email-link.routes.js";
import { sessionRoutes } from "./api/routes/session.routes.js";
import { socialLinkRoutes } from "./api/routes/social-link.routes.js";
import { testPushRoutes } from "./api/routes/test-push.routes.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";

const app: Express = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(localeMiddleware);

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "auth-service",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/auth", accountRoutes);
app.use("/api/auth", emailLinkRoutes);
app.use("/api/auth", changeEmailRoutes);
app.use("/api/auth", changePasswordRoutes);
app.use("/api/auth", sessionRoutes);
app.use("/api/auth", socialLinkRoutes);
app.use("/api/auth", deviceLinkRoutes);
app.use("/api/auth", accountDeletionRoutes);

// Dev-only test endpoint for FCM push. Remove once normal push is wired.
if (env.NODE_ENV === "development") {
  app.use("/api/auth", testPushRoutes);
}

app.use(errorHandler);

export default app;

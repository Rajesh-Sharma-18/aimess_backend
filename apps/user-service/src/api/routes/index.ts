import { Router, type IRouter } from "express";

import { accountRoutes } from "./account.routes.js";
import { friendsRoutes } from "./friends.routes.js";
import { profileRoutes } from "./profile.routes.js";
import { settingsRoutes } from "./settings.routes.js";
import { uploadRoutes } from "./upload.routes.js";
import { usernameRoutes } from "./username.routes.js";

/** API v1 routes — mounted at `/api/v1` (same idea as `authRoutes` at `/api/auth`). */
export const userRoutes: IRouter = Router();

userRoutes.use("/accounts", accountRoutes);
userRoutes.use("/friends", friendsRoutes);
userRoutes.use("/settings", settingsRoutes);
userRoutes.use("/uploads", uploadRoutes);
userRoutes.use("/usernames", usernameRoutes);
userRoutes.use("/profiles", profileRoutes);

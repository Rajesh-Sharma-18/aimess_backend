import { Router, type IRouter } from "express";

import { profileRoutes } from "./profile.routes.js";
import { usernameRoutes } from "./username.routes.js";

/** API v1 routes — mounted at `/api/v1` (same idea as `authRoutes` at `/api/auth`). */
export const userRoutes: IRouter = Router();

userRoutes.use("/usernames", usernameRoutes);
userRoutes.use("/profiles", profileRoutes);

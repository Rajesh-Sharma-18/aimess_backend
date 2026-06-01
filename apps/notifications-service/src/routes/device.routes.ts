import { Router, type IRouter } from "express";

import { createAuthenticateAccessToken } from "@aimess/auth-jwt";

import { env } from "../config/env.js";
import {
  registerDevice,
  unregisterDevice,
} from "../api/controllers/device.controller.js";

export const deviceRouter: IRouter = Router();

const authenticate = createAuthenticateAccessToken(env.JWT_ACCESS_SECRET);

deviceRouter.post("/", authenticate, registerDevice);
deviceRouter.delete("/:token", authenticate, unregisterDevice);

import { Router, type IRouter } from "express";
import express from "express";

import { checkAppVersion } from "../../app-version/app-version.controller.js";

export const appVersionRouter: IRouter = Router();

appVersionRouter.use(express.json({ limit: "32kb" }));
appVersionRouter.post("/check", checkAppVersion);

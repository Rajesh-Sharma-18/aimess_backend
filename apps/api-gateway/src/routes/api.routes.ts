import { Router, type IRouter } from "express";

import { API_VERSIONS, DEFAULT_API_VERSION } from "../versioning/types.js";
import { v1Router } from "./v1/index.js";

export const apiRouter: IRouter = Router();

apiRouter.use("/v1", v1Router);

/** Reserved: mount `v2Router` at `/v2` when breaking changes ship. */

export function listMountedApiVersions(): string[] {
  return [...API_VERSIONS];
}

export { DEFAULT_API_VERSION };

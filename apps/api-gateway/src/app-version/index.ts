import { getRedis, readAppUpdatePolicy } from "@aimess/redis";

import { env, getDefaultAppVersionConfig } from "../config/env.js";
import { createAppVersionService } from "./app-version.service.js";
import {
  createAppVersionStore,
  resolveDefaultConfigPath,
} from "./app-version.store.js";

const store = createAppVersionStore({
  configPath: env.APP_VERSION_CONFIG_PATH ?? resolveDefaultConfigPath(),
  defaults: getDefaultAppVersionConfig(),
});

// getRedis() throws until connectRedis() has run; `async` turns that into a
// rejection the service treats as "nothing published" and serves the static policy.
export const appVersionService = createAppVersionService(store, async () =>
  readAppUpdatePolicy(getRedis())
);

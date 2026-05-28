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

export const appVersionService = createAppVersionService(store);

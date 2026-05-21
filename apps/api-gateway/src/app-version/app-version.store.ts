import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppVersionConfig, PlatformVersionPolicy } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.resolve(
  moduleDir,
  "../../config/app-versions.json"
);

export type AppVersionStoreOptions = {
  configPath: string;
  defaults: AppVersionConfig;
};

let cached: AppVersionConfig | null = null;

function isPlatformPolicy(value: unknown): value is PlatformVersionPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as PlatformVersionPolicy;
  return (
    typeof policy.mandatoryUpdate === "string" &&
    typeof policy.optionalUpdate === "string"
  );
}

function parseConfig(raw: string): AppVersionConfig {
  const parsed = JSON.parse(raw) as Partial<AppVersionConfig>;

  if (!isPlatformPolicy(parsed.android) || !isPlatformPolicy(parsed.ios)) {
    throw new Error("Invalid app version config file");
  }

  return {
    android: parsed.android,
    ios: parsed.ios,
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}

export function createAppVersionStore(options: AppVersionStoreOptions) {
  const { configPath, defaults } = options;

  return {
    async get(): Promise<AppVersionConfig> {
      if (cached) return cached;

      try {
        const raw = await readFile(configPath, "utf8");
        cached = parseConfig(raw);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          cached = defaults;
        } else {
          throw error;
        }
      }

      return cached;
    },
  };
}

export type AppVersionStore = ReturnType<typeof createAppVersionStore>;

export function resolveDefaultConfigPath(): string {
  return defaultConfigPath;
}

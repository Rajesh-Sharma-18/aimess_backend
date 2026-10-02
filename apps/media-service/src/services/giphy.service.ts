import { ServiceUnavailableError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { getBackofficeClient } from "../grpc/clients/backoffice.client.js";

const GIPHY_API_URL = "https://api.giphy.com/v1";
const REQUEST_TIMEOUT_MS = 5000;
const KEY_TTL_MS = 60_000;

export type GifSearchParams = {
  q?: string;
  type: "gifs" | "stickers";
  offset: number;
  limit: number;
};

export const GIPHY_CREDENTIAL_NAME = "GIPHY_API_KEY";

export type GiphyPlatform = "ANDROID" | "IOS" | "WEB";

export function giphyPlatformFor(platform: string | undefined): GiphyPlatform {
  const normalized = platform?.trim().toLowerCase();
  if (normalized === "android") return "ANDROID";
  if (normalized === "ios") return "IOS";
  return "WEB";
}

export type GifSearchResult = {
  data: unknown[];
  pagination: unknown;
  meta: unknown;
};

const cachedKeys = new Map<GiphyPlatform, { value: string | null; expiresAt: number }>();

async function resolveApiKey(platform: GiphyPlatform): Promise<string | null> {
  const cached = cachedKeys.get(platform);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let credential;
  try {
    credential = await getBackofficeClient().getCustomCredential(
      GIPHY_CREDENTIAL_NAME,
      platform
    );
  } catch (error) {
    logger.warn(`giphy|credential lookup failed: ${String(error)}`);
    throw new ServiceUnavailableError("GIPHY_UNAVAILABLE");
  }
  const value = credential.configured && credential.value ? credential.value : null;
  cachedKeys.set(platform, { value, expiresAt: Date.now() + KEY_TTL_MS });
  return value;
}

export const giphyService = {
  async search(params: GifSearchParams, platform: GiphyPlatform): Promise<GifSearchResult> {
    const apiKey = await resolveApiKey(platform);
    if (!apiKey) throw new ServiceUnavailableError("GIPHY_NOT_CONFIGURED");

    const url = new URL(`${GIPHY_API_URL}/${params.type}/${params.q ? "search" : "trending"}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("offset", String(params.offset));
    url.searchParams.set("limit", String(params.limit));
    if (params.q) url.searchParams.set("q", params.q);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) cachedKeys.delete(platform);
        logger.warn(`giphy|upstream responded ${res.status}`);
        throw new ServiceUnavailableError("GIPHY_UNAVAILABLE");
      }
      const body = (await res.json()) as Partial<GifSearchResult>;
      return {
        data: Array.isArray(body.data) ? body.data : [],
        pagination: body.pagination ?? null,
        meta: body.meta ?? null,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableError) throw error;
      logger.warn(`giphy|request failed: ${error instanceof Error ? error.name : "unknown"}`);
      throw new ServiceUnavailableError("GIPHY_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  },
};

import type { Request, Response } from "express";
import type { z } from "zod";

import { extractBearerToken, verifyAccessToken } from "@aimess/auth-jwt";
import { BadRequestError } from "@aimess/errors";
import { getRedis, isUserBanned } from "@aimess/redis";
import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import {
  checkAppVersionSchema,
  type CheckAppVersionInput,
} from "./app-version.validator.js";
import { appVersionService } from "./index.js";
import { accessTokenVerifyConfig } from "../config/env.js";
import { listCustomCredentials } from "../grpc/clients/backoffice.client.js";

function validateBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("VALIDATION_FAILED");
  }
  return parsed.data;
}

async function credentialsFor(
  req: Request,
  platform: CheckAppVersionInput["platform"]
): Promise<Record<string, string>> {
  try {
    const token = extractBearerToken(req.headers.authorization);
    const { userId } = verifyAccessToken(token, accessTokenVerifyConfig);
    if (await isUserBanned(getRedis(), userId)) return {};
  } catch {
    return {};
  }
  return listCustomCredentials(platform === "ios" ? "IOS" : "ANDROID");
}

export const checkAppVersion = asyncHandler(
  async (req: Request, res: Response) => {
    const body = validateBody<CheckAppVersionInput>(
      checkAppVersionSchema,
      req.body
    );
    const [result, credentials] = await Promise.all([
      appVersionService.check(body),
      credentialsFor(req, body.platform),
    ]);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse({ ...result, credentials }, t("APP_VERSION_CHECKED", req.locale))
      );
  }
);

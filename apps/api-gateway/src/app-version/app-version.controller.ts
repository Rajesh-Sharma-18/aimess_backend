import type { Request, Response } from "express";
import type { z } from "zod";

import { BadRequestError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import {
  checkAppVersionSchema,
  type CheckAppVersionInput,
} from "./app-version.validator.js";
import { appVersionService } from "./index.js";

function validateBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("VALIDATION_FAILED");
  }
  return parsed.data;
}

export const checkAppVersion = asyncHandler(
  async (req: Request, res: Response) => {
    const body = validateBody<CheckAppVersionInput>(
      checkAppVersionSchema,
      req.body
    );
    const result = await appVersionService.check(body);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, "App version checked"));
  }
);

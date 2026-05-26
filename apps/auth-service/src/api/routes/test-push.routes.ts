// DEV ONLY — remove this file when FCM is wired through the real
// notification consumer. Lets you trigger a push to all of a user's devices
// by email, with no auth.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { HTTP_STATUS } from "@aimess/constants";
import { logger } from "@aimess/logger";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";

import { env } from "../../config/env.js";
import { authRepository } from "../../repositories/auth.repository.js";
import { validateBody } from "../middleware/validate-body.js";

export const testPushRoutes: IRouter = Router();

const testPushSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(500).optional(),
});

type TestPushInput = z.infer<typeof testPushSchema>;

testPushRoutes.post(
  "/test/push",
  validateBody(testPushSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, title, body } = req.body as TestPushInput;

    const user = await authRepository.findByEmail(email);
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    const tokens = user.fcmTokens ?? [];
    if (tokens.length === 0) {
      return res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { userId: user.id, deviceCount: 0, results: [] },
            "User has no FCM tokens registered."
          )
        );
    }

    const payload = {
      tokens,
      title: title ?? "AIMess test push",
      body: body ?? `Hello ${user.account}! This is a test notification.`,
    };

    let downstream: {
      results: Array<{ token: string; ok: boolean; error?: string }>;
    };
    try {
      const response = await fetch(
        `${env.NOTIFICATIONS_SERVICE_URL}/test/push`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        logger.error(
          `notifications-service /test/push returned ${response.status}: ${text}`
        );
        return res
          .status(HTTP_STATUS.BAD_GATEWAY)
          .json(
            new ApiResponse(
              { upstream: response.status },
              "notifications-service rejected the request."
            )
          );
      }

      downstream = (await response.json()) as typeof downstream;
    } catch (error) {
      logger.error("Failed to reach notifications-service /test/push", error);
      return res
        .status(HTTP_STATUS.BAD_GATEWAY)
        .json(
          new ApiResponse(
            null,
            "Could not reach notifications-service. Is it running?"
          )
        );
    }

    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          userId: user.id,
          deviceCount: tokens.length,
          results: downstream.results,
        },
        "Test push dispatched."
      )
    );
  })
);

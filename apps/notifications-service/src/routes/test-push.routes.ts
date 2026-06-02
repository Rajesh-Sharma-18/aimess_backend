// DEV ONLY — remove this file when normal FCM push is wired through the
// consumer. Accepts a token list and fires off a sendPush() per token.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logger } from "@aimess/logger";

import { sendPush } from "../providers/firebase/sendPush.js";

export const testPushRouter: IRouter = Router();

const testPushSchema = z.object({
  tokens: z.array(z.string().min(1)).min(1),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
});

testPushRouter.post("/push", async (req: Request, res: Response) => {
  const parsed = testPushSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid body",
      issues: parsed.error.issues,
    });
  }

  const { tokens, title, body } = parsed.data;

  const results = await Promise.all(
    tokens.map(async (token) => {
      try {
        const { messageId } = await sendPush({ token, title, body });
        return { token, ok: messageId !== null, messageId };
      } catch (error) {
        logger.error("sendPush threw for token", error);
        const message =
          error instanceof Error ? error.message : "unknown error";
        return { token, ok: false, error: message };
      }
    })
  );

  const okCount = results.filter((r) => r.ok).length;

  return res.status(200).json({
    success: true,
    sent: okCount,
    total: tokens.length,
    results,
  });
});

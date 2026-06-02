import type { Request, Response } from "express";

import { logger } from "@aimess/logger";

import { deviceTokenService } from "../../services/device-token.service.js";
import {
  registerDeviceSchema,
  unregisterDeviceParamsSchema,
} from "../validators/device.validator.js";

/** POST /v1/devices — upsert the caller's FCM token. */
export async function registerDevice(
  req: Request,
  res: Response
): Promise<Response> {
  const parsed = registerDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid body",
      issues: parsed.error.issues,
    });
  }

  try {
    await deviceTokenService.registerDevice({
      userId: req.auth.userId,
      token: parsed.data.token,
      platform: parsed.data.platform,
      deviceId: parsed.data.deviceId ?? null,
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error("registerDevice failed", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to register device" });
  }
}

/** DELETE /v1/devices/:token — unregister one of the caller's tokens. */
export async function unregisterDevice(
  req: Request,
  res: Response
): Promise<Response> {
  const parsed = unregisterDeviceParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid token param",
      issues: parsed.error.issues,
    });
  }

  try {
    const removed = await deviceTokenService.unregisterDevice(
      req.auth.userId,
      parsed.data.token
    );
    return res.status(200).json({ success: true, removed });
  } catch (error) {
    logger.error("unregisterDevice failed", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to unregister device" });
  }
}

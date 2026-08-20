import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";

import { deviceTokenService } from "../../services/device-token.service.js";
import type {
  RegisterDeviceInput,
  UnregisterDeviceParams,
} from "../validators/device.validator.js";

/**
 * POST /v1/devices - upsert the caller's FCM token.
 *
 * Validation moved to `validateBody` on the route and the try/catch was
 * removed: both hand-rolled their own response body, so a failed registration
 * answered `{ success: false, message: "Failed to register device" }` with no
 * code, no request id, and no localization. `asyncHandler` forwards a throw to
 * the shared error handler, which is the only place an envelope is built.
 */
export const registerDevice = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RegisterDeviceInput;

    await deviceTokenService.registerDevice({
      userId: req.auth.userId,
      token: body.token,
      platform: body.platform,
      tokenType: body.tokenType,
      deviceId: body.deviceId ?? null,
      // Server-derived, never client-supplied: it is what lets session
      // revocation (logout / "Logout Device" / sign-out-all) delete exactly
      // this row instead of guessing from the client's opaque deviceId.
      sessionId: req.auth.sessionId,
    });

    return res.status(200).json(new ApiResponse(null, "Device registered"));
  }
);

/** DELETE /v1/devices/:token - unregister one of the caller's tokens. */
export const unregisterDevice = asyncHandler(
  async (req: Request, res: Response) => {
    const { token } = req.params as unknown as UnregisterDeviceParams;

    const removed = await deviceTokenService.unregisterDevice(
      req.auth.userId,
      token
    );

    return res
      .status(200)
      .json(new ApiResponse({ removed }, "Device unregistered"));
  }
);

import { randomBytes } from "node:crypto";

import type { Request } from "express";

import { ConflictError, NotFoundError } from "@aimess/errors";

import type {
  ApproveDeviceLinkInput,
  InitiateDeviceLinkInput,
} from "../api/validators/device-link.validator.js";
import { DeviceType } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";
import {
  approveLinkSessionAtomic,
  consumeTokensAtomic,
  createLinkSession,
  getLinkSession,
} from "../lib/device-link-store.js";
import { buildSessionContext } from "../lib/session-context.js";
import type { SessionContext } from "../lib/session-context.js";
import { hashToken, issueAuthTokens } from "../lib/token.js";
import type {
  ApproveDeviceLinkResult,
  DeviceLinkStatusResult,
  InitiateDeviceLinkResult,
} from "../types/device-link.types.js";

/** Map a free-text device type from the new device onto the Prisma enum. */
function resolveDeviceType(value: string | null): DeviceType {
  switch ((value ?? "").toUpperCase()) {
    case "IOS":
      return DeviceType.IOS;
    case "ANDROID":
      return DeviceType.ANDROID;
    case "DESKTOP":
      return DeviceType.DESKTOP;
    default:
      return DeviceType.WEB;
  }
}

export const deviceLinkService = {
  async initiate(
    req: Request,
    input: InitiateDeviceLinkInput
  ): Promise<InitiateDeviceLinkResult> {
    const fallback = buildSessionContext(req);

    const { linkToken, pollSecret, expiresAt } = await createLinkSession({
      deviceName: input.deviceName ?? fallback.deviceName,
      deviceType: input.deviceType ?? fallback.deviceType,
      os: input.os ?? fallback.osVersion,
      appVersion: input.appVersion ?? fallback.appVersion,
    });

    return { linkToken, pollSecret, expiresAt };
  },

  async getStatus(
    linkToken: string,
    pollSecret: string
  ): Promise<DeviceLinkStatusResult> {
    const record = await getLinkSession(linkToken);

    // Missing record or a wrong pollSecret look identical to the caller — no
    // enumeration leak between an expired session and a guessed token.
    if (!record || hashToken(pollSecret) !== record.pollSecretHash) {
      return { state: "EXPIRED", approvedDeviceLabel: null, tokens: null };
    }

    if (record.state === "PENDING") {
      return { state: "PENDING", approvedDeviceLabel: null, tokens: null };
    }

    if (record.state === "APPROVED") {
      // Single-use: flips to CONSUMED and hands back the tokens exactly once.
      const consumed = await consumeTokensAtomic(linkToken);
      return {
        state: consumed.tokens ? "APPROVED" : consumed.state,
        approvedDeviceLabel: consumed.approvedDeviceLabel,
        tokens: consumed.tokens,
      };
    }

    return { state: "CONSUMED", approvedDeviceLabel: null, tokens: null };
  },

  async approve(
    req: Request,
    userId: string,
    input: ApproveDeviceLinkInput
  ): Promise<ApproveDeviceLinkResult> {
    const record = await getLinkSession(input.linkToken);
    if (!record) {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }

    // Synthetic context for the NEW device with a FRESH random deviceId so
    // createSessionWithRefreshToken's deleteMany cannot wipe the approver's own
    // session (which would happen if we reused buildSessionContext(req)).
    const syntheticContext: SessionContext = {
      deviceId: randomBytes(16).toString("hex"),
      deviceType: resolveDeviceType(record.device.deviceType),
      deviceName: record.device.deviceName,
      osVersion: record.device.os,
      appVersion: record.device.appVersion,
      ipAddress: null,
      userAgent: null,
    };

    // The approver is linking a NEW device to their OWN account, so the new
    // session must carry the approving user's real platform role.
    const approver = await authRepository.findRoleByUserId(userId);
    const role = approver?.role === "ADMIN" ? "ADMIN" : "USER";

    const { tokens, sessionId } = await issueAuthTokens(
      userId,
      role,
      syntheticContext
    );

    const result = await approveLinkSessionAtomic(
      input.linkToken,
      tokens,
      input.deviceLabel ?? null
    );

    if (result === "ALREADY") {
      throw new ConflictError("AUTH_DEVICE_LINK_ALREADY_APPROVED");
    }

    if (result === "NOT_FOUND") {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }

    // sessionId of the newly-linked device — lets the approver "undo" the link
    // by revoking just that session (DELETE /auth/sessions/:sessionId).
    return { linkedAt: new Date().toISOString(), sessionId };
  },
};

import { randomBytes } from "node:crypto";

import type { Request } from "express";

import { ConflictError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { publishQrLinkEvent } from "@aimess/redis";

import type {
  ApproveDeviceLinkInput,
  InitiateDeviceLinkInput,
  RejectDeviceLinkInput,
  ScanDeviceLinkInput,
} from "../api/validators/device-link.validator.js";
import { redis } from "../config/redis.js";
import { DeviceType } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";
import {
  approveLinkSessionAtomic,
  consumeTokensAtomic,
  createLinkSession,
  getLinkSession,
  rejectLinkSessionAtomic,
  scanLinkSessionAtomic,
} from "../lib/device-link-store.js";
import { buildSessionContext } from "../lib/session-context.js";
import type { SessionContext } from "../lib/session-context.js";
import { hashToken, issueAuthTokens } from "../lib/token.js";
import { recordAuditEventSafe } from "./audit.service.js";
import type {
  ApproveDeviceLinkResult,
  DeviceLinkPendingDetails,
  DeviceLinkStatusResult,
  InitiateDeviceLinkResult,
  RejectDeviceLinkResult,
  ScanDeviceLinkResult,
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

    recordAuditEventSafe({
      event: "QR_CREATED",
      targetType: "qr_login_session",
      targetId: linkToken,
      ip: fallback.ipAddress,
    });

    // auth:qr:expired is now pushed by the scheduler-driven sweeper
    // (jobs/qr-link-expiry-sweeper.ts), not an in-process timer here — it
    // survives restarts and coordinates correctly across replicas.

    return { linkToken, pollSecret, expiresAt };
  },

  /** Any authenticated user may preview a pending QR before deciding to scan/approve it. */
  async getPendingDetails(
    linkToken: string
  ): Promise<DeviceLinkPendingDetails> {
    const record = await getLinkSession(linkToken);
    if (!record) {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }

    return {
      state: record.state,
      device: record.device,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  },

  /** The already-signed-in device that scanned the QR marks it SCANNED (pre-approval). */
  async scan(
    userId: string,
    input: ScanDeviceLinkInput
  ): Promise<ScanDeviceLinkResult> {
    const record = await getLinkSession(input.linkToken);
    if (!record) {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }

    const result = await scanLinkSessionAtomic(input.linkToken, userId);
    if (result === "ALREADY") {
      throw new ConflictError("AUTH_DEVICE_LINK_ALREADY_SCANNED");
    }
    if (result === "NOT_FOUND") {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }
    if (result === "EXPIRED") {
      throw new NotFoundError("AUTH_DEVICE_LINK_EXPIRED");
    }

    const scannedAt = new Date().toISOString();
    recordAuditEventSafe({
      event: "QR_SCANNED",
      targetType: "qr_login_session",
      targetId: input.linkToken,
      userId,
    });

    void publishQrLinkEvent(redis, input.linkToken, "auth:qr:scanned", {
      linkToken: input.linkToken,
      device: record.device,
    }).catch((err: unknown) =>
      logger.warn(`Failed to publish auth:qr:scanned: ${String(err)}`)
    );

    return { scannedAt, device: record.device };
  },

  /** The scanning user declines the login. */
  async reject(
    userId: string,
    input: RejectDeviceLinkInput
  ): Promise<RejectDeviceLinkResult> {
    const result = await rejectLinkSessionAtomic(input.linkToken, userId);

    if (result === "NOT_FOUND") {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }
    if (result === "NOT_SCANNED") {
      throw new ConflictError("AUTH_DEVICE_LINK_NOT_SCANNED");
    }
    if (result === "WRONG_USER") {
      throw new ForbiddenError("AUTH_DEVICE_LINK_WRONG_USER");
    }
    if (result === "ALREADY") {
      throw new ConflictError("AUTH_DEVICE_LINK_ALREADY_APPROVED");
    }
    if (result === "EXPIRED") {
      throw new NotFoundError("AUTH_DEVICE_LINK_EXPIRED");
    }

    const rejectedAt = new Date().toISOString();
    recordAuditEventSafe({
      event: "QR_REJECTED",
      targetType: "qr_login_session",
      targetId: input.linkToken,
      userId,
    });

    void publishQrLinkEvent(redis, input.linkToken, "auth:qr:rejected", {
      linkToken: input.linkToken,
    }).catch((err: unknown) =>
      logger.warn(`Failed to publish auth:qr:rejected: ${String(err)}`)
    );

    return { rejectedAt };
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

    return { state: "USED", approvedDeviceLabel: null, tokens: null };
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
      input.deviceLabel ?? null,
      userId
    );

    if (result === "ALREADY") {
      throw new ConflictError("AUTH_DEVICE_LINK_ALREADY_APPROVED");
    }
    if (result === "NOT_FOUND") {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }
    if (result === "NOT_SCANNED") {
      throw new ConflictError("AUTH_DEVICE_LINK_NOT_SCANNED");
    }
    if (result === "WRONG_USER") {
      throw new ForbiddenError("AUTH_DEVICE_LINK_WRONG_USER");
    }
    if (result === "EXPIRED") {
      throw new NotFoundError("AUTH_DEVICE_LINK_EXPIRED");
    }

    recordAuditEventSafe({
      event: "QR_APPROVED",
      targetType: "qr_login_session",
      targetId: input.linkToken,
      userId,
      metadata: { sessionId },
    });
    recordAuditEventSafe({
      event: "BROWSER_LOGGED_IN",
      targetType: "qr_login_session",
      targetId: input.linkToken,
      userId,
    });

    // The browser never sees the QR token payload it can't already read off
    // its own screen — but it DOES receive the tokens here, once, over its own
    // private `qr:{linkToken}` room. No JWT/refresh token/userId in any other
    // auth:qr:* event.
    void publishQrLinkEvent(redis, input.linkToken, "auth:qr:approved", {
      linkToken: input.linkToken,
      tokens,
      user: { userId, role },
    }).catch((err: unknown) =>
      logger.warn(`Failed to publish auth:qr:approved: ${String(err)}`)
    );

    // sessionId of the newly-linked device — lets the approver "undo" the link
    // by revoking just that session (DELETE /auth/sessions/:sessionId).
    return { linkedAt: new Date().toISOString(), sessionId };
  },
};

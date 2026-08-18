import { randomBytes } from "node:crypto";

import type { Request } from "express";

import { ConflictError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import {
  publishQrLinkEvent,
  publishQrLinkSuccess,
  takeQrLinkResult,
} from "@aimess/redis";

import type {
  InitiateDeviceLinkInput,
  ScanDeviceLinkInput,
  DeviceLinkResultInput,
} from "../api/validators/device-link.validator.js";
import { redis } from "../config/redis.js";
import { DeviceType } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";
import {
  claimLinkSessionAtomic,
  createLinkSession,
  finalizeLoginAtomic,
  getLinkSession,
} from "../lib/device-link-store.js";
import { assertNotBanned } from "../lib/account-guard.js";
import { buildSessionContext } from "../lib/session-context.js";
import type { SessionContext } from "../lib/session-context.js";
import { issueAuthTokens } from "../lib/token.js";
import { recordAuditEventSafe } from "./audit.service.js";
import type {
  DeviceLinkResultResponse,
  InitiateDeviceLinkResult,
  LoginDeviceLinkResult,
  QrLinkSuccessPayload,
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
    // Body may still carry legacy deviceName/deviceType/os/appVersion fields
    // (accepted by the validator for backward compat with older clients) but
    // they are intentionally never read: buildSessionContext(req) is the ONE
    // source of truth for device metadata, shared byte-for-byte with
    // login/register, so a client can no longer poison deviceName with an
    // arbitrary string (e.g. its own raw User-Agent) by putting it in the body.
    // `clientId` is the one exception — see the fingerprint note below; it is
    // an index key, not metadata, and never reaches the session record.
    input: InitiateDeviceLinkInput
  ): Promise<InitiateDeviceLinkResult> {
    const context = buildSessionContext(req);

    // The "one active QR per browser" index key.
    //
    // It must identify a BROWSER. `context.deviceId` is sha256(userAgent | ip),
    // which does not: every visitor behind the same NAT egress IP running the
    // same browser build collides onto one fingerprint — an office, a campus,
    // a carrier CGNAT, or simply two tabs of the same browser. Under that
    // collision, one visitor opening the login page silently CANCELs another
    // visitor's still-displayed QR, whose browser then scans a dead token.
    //
    // So prefer the client's own opaque, persistent id and fall back to the
    // UA+IP hash only for clients that don't send one (older builds, native).
    // Guessing another browser's random clientId is the only way to cancel its
    // session now, and a cancelled session can never be logged into anyway.
    const fingerprint = input.clientId
      ? `client:${input.clientId}`
      : context.deviceId;

    // WhatsApp-like: createLinkSession automatically cancels any prior PENDING
    // session from the same browser and returns the cancelled token so we can
    // notify the old browser tab immediately. This eliminates stale PENDING
    // accumulation and prevents the IP-based rate limiter from firing during
    // normal usage (refresh, regeneration).
    const { linkToken, expiresAt, cancelledToken } = await createLinkSession(
      {
        deviceName: context.deviceName,
        deviceType: context.deviceType,
        os: context.osVersion,
        appVersion: context.appVersion,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        countryCode: context.countryCode,
      },
      fingerprint
    );

    // If a prior session was superseded, notify its waiting browser tab
    // immediately via auth:qr:cancelled so the UI can react (e.g. show
    // "Session replaced" and immediately subscribe to the new token).
    // Fire-and-forget — a Redis hiccup must never fail QR generation.
    if (cancelledToken) {
      recordAuditEventSafe({
        event: "QR_CANCELLED",
        targetType: "qr_login_session",
        targetId: cancelledToken,
        ip: context.ipAddress,
        metadata: { replacedBy: linkToken },
      });

      void publishQrLinkEvent(redis, cancelledToken, "auth:qr:cancelled", {
        linkToken: cancelledToken,
        reason: "replaced",
      }).catch((err: unknown) =>
        logger.warn(`Failed to publish auth:qr:cancelled: ${String(err)}`)
      );
    }

    recordAuditEventSafe({
      event: "QR_CREATED",
      targetType: "qr_login_session",
      targetId: linkToken,
      ip: context.ipAddress,
    });

    // auth:qr:expired is pushed by the scheduler-driven sweeper
    // (jobs/qr-link-expiry-sweeper.ts), which survives restarts and
    // coordinates correctly across replicas.

    return { linkToken, expiresAt };
  },

  /**
   * Pull the outcome of a QR session — the browser-facing counterpart of the
   * `auth:qr:success` push, and the reason a completed scan can no longer strand
   * the browser on "waiting".
   *
   * The push path is Redis pub/sub, which buffers nothing: an `auth:qr:success`
   * published while the browser's `/auth` socket is mid-handshake, blocked by a
   * proxy, backgrounded, or already torn down (the browser rotates its QR every
   * TTL and drops the old room with it) is discarded forever — while the phone
   * that scanned has already been told the login succeeded. `publishQrLinkSuccess`
   * parks a one-shot copy in Redis for exactly this case, but until now only a
   * gateway `auth:qr:subscribe` could collect it, so a browser with no working
   * socket had no way to reach it at all.
   *
   * This endpoint collects that same one-shot envelope over plain HTTP, so the
   * browser can poll and become authenticated with the socket missed, delayed,
   * or never connected. Single-use is preserved — `takeQrLinkResult` is an
   * atomic GET+DEL, so the tokens go to whichever path arrives first and to
   * nobody twice; a second call reports CONSUMED, not another set of tokens.
   * Exposure is unchanged: possession of the linkToken has always been the bar
   * for receiving them.
   */
  async result(
    input: DeviceLinkResultInput
  ): Promise<DeviceLinkResultResponse> {
    const pending = await takeQrLinkResult(redis, input.linkToken);
    if (pending) {
      return {
        status: "SUCCESS",
        session: pending.data as QrLinkSuccessPayload,
      };
    }

    const record = await getLinkSession(input.linkToken);
    if (!record) return { status: "NOT_FOUND", session: null };

    switch (record.state) {
      // The login completed; its envelope went to an earlier collector (the
      // socket relay, or this browser's own previous poll).
      case "USED":
        return { status: "CONSUMED", session: null };
      case "CANCELLED":
        return { status: "CANCELLED", session: null };
      default:
        // PENDING/SCANNED past its deadline reads as EXPIRED whether or not the
        // sweeper has reached it yet — claim/finalize enforce the same instant.
        return new Date(record.expiresAt).getTime() <= Date.now()
          ? { status: "EXPIRED", session: null }
          : { status: "PENDING", session: null };
    }
  },

  /**
   * Telegram-style instant login: the already-signed-in mobile device scans
   * the QR and this single call validates it, mints a brand-new web session
   * (via the same `issueAuthTokens` every login path uses), and marks the QR
   * USED — no separate approve/reject step, no confirmation screen.
   */
  async login(
    req: Request,
    userId: string,
    input: ScanDeviceLinkInput
  ): Promise<LoginDeviceLinkResult> {
    const record = await getLinkSession(input.linkToken);
    if (!record) {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }

    // Atomic claim: only one concurrent login attempt on this QR can win.
    const claim = await claimLinkSessionAtomic(input.linkToken, userId);
    if (claim === "NOT_FOUND") {
      throw new NotFoundError("AUTH_DEVICE_LINK_NOT_FOUND");
    }
    if (claim === "EXPIRED") {
      throw new NotFoundError("AUTH_DEVICE_LINK_EXPIRED");
    }
    if (claim === "ALREADY") {
      recordAuditEventSafe({
        event: "QR_REUSED_ATTEMPT",
        targetType: "qr_login_session",
        targetId: input.linkToken,
        userId,
      });
      throw new ConflictError("AUTH_DEVICE_LINK_ALREADY_SCANNED");
    }

    recordAuditEventSafe({
      event: "QR_LOGIN_ATTEMPT",
      targetType: "qr_login_session",
      targetId: input.linkToken,
      userId,
    });

    // Synthetic context for the NEW (web) device with a FRESH random deviceId
    // so createSessionWithRefreshToken's deleteMany cannot wipe the caller's
    // own (mobile) session, which would happen if we reused buildSessionContext(req)
    // here. Note `req` in this handler is the SCANNING (mobile) device's
    // request — every field on it (ip/userAgent/appVersion/...) belongs to the
    // phone, not the browser being linked, so NONE of it may leak into the new
    // session (this previously happened for appVersion via `input.appVersion`,
    // the same class of bug as the ip/userAgent mix-up). The browser's own
    // metadata — via the ONE shared buildSessionContext(req) call — was
    // captured once at initiate() time and carried on the QR record instead.
    const syntheticContext: SessionContext = {
      deviceId: randomBytes(16).toString("hex"),
      deviceType: resolveDeviceType(record.device.deviceType),
      deviceName: record.device.deviceName,
      // DeviceLinkDeviceInfo doesn't persist browser/OS names separately (only
      // the combined deviceName) — the login-detected copy gracefully degrades
      // to "a new device" for QR-linked logins, same as any UA it can't parse.
      browserName: null,
      osName: null,
      osVersion: record.device.os,
      appVersion: record.device.appVersion,
      ipAddress: record.device.ipAddress,
      userAgent: record.device.userAgent,
      countryCode: record.device.countryCode,
    };

    // The scanning user is linking a NEW device to their OWN account, so the
    // new session must carry their real platform role.
    const scanner = await authRepository.findRoleByUserId(userId);

    // QR device-link is the one login path that never re-reads account status:
    // it trusts the scanner's access token, which stays cryptographically
    // valid for its full lifetime after a ban. Without this a banned user
    // could keep minting fresh browser sessions until that token expired.
    if (scanner) {
      assertNotBanned(scanner.status);
    }

    const role = scanner?.role === "ADMIN" ? "ADMIN" : "USER";

    // QR linking is self-initiated from an already-authenticated device of the
    // SAME user (spec §7) — suppress LOGIN_DETECTED / auth.security_new_login.
    // Session, Linked Devices, audit, and session:list_updated still fire above.
    const { tokens, sessionId } = await issueAuthTokens(
      userId,
      role,
      syntheticContext,
      undefined,
      { notifyNewLogin: false }
    );

    // Finalize: SCANNED (just claimed above, same request) -> USED. NOT_SCANNED/
    // WRONG_USER/ALREADY are unreachable (this call always finalizes the exact
    // claim it just won, with the same userId) but are still guarded defensively.
    // The fingerprint pointer is NOT cleaned up here — the browser's fingerprint
    // isn't recoverable from the phone's request. It is harmless: it expires with
    // the record, and the next createLinkSession for that browser DELs the stale
    // pointer after the cancel script reports the token is already terminal.
    const finalize = await finalizeLoginAtomic(input.linkToken, userId);
    if (finalize !== "OK") {
      throw new NotFoundError("AUTH_DEVICE_LINK_EXPIRED");
    }

    recordAuditEventSafe({
      event: "QR_LOGIN_SUCCESS",
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

    publishAdminActivitySafe({
      actorId: userId,
      action: USER_AUDIT_ACTIONS.USER_DEVICE_LINKED,
      targetType: "session",
      targetId: sessionId,
      after: { deviceName: record.device.deviceName },
      ip: record.device.ipAddress,
      userAgent: record.device.userAgent,
    });

    // The browser only ever receives tokens/userId over this one event, on
    // its own private `qr:{linkToken}` room — never in any other auth:qr:* event.
    //
    // publishQrLinkSuccess (not publishQrLinkEvent) because pub/sub alone drops
    // the event — and with it the only copy of these tokens — if the browser's
    // socket is mid-handshake or briefly offline at this instant. It also parks
    // a one-shot copy the gateway hands over on the browser's next subscribe.
    void publishQrLinkSuccess(redis, input.linkToken, {
      linkToken: input.linkToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      deviceId: sessionId,
      user: { userId, role },
    }).catch((err: unknown) =>
      logger.warn(`Failed to publish auth:qr:success: ${String(err)}`)
    );

    return {
      linkedAt: new Date().toISOString(),
      sessionId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      refreshTokenExpiresIn: tokens.refreshTokenExpiresIn,
    };
  },
};

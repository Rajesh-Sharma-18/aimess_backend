import { Router, type IRouter, type Request, type Response } from "express";

import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { BadRequestError, NotFoundError } from "@aimess/errors";

import { env } from "../../config/env.js";
import { fetchPublicCommunityCard } from "../../linkhost/public-card.js";
import { fetchGroupInviteCard } from "../../linkhost/group-card.js";

/**
 * `GET /api/v1/invites/details?slugOrToken=<x>&type=community|group`
 *
 * Unauthenticated preview metadata for a shared link, used by the web
 * interstitial (`/link`) to render the real name / avatar / member count
 * instead of a hardcoded "AIMESS community" card, and by any client that wants
 * the same card without a session.
 *
 * PUBLIC communities only — a private community's handle is not resolvable and
 * its invite CODE is deliberately not accepted here, so a code pasted into a
 * chat cannot be turned into a metadata leak. Group tokens are accepted because
 * holding the token already is the authorization (chat-service's own preview
 * endpoint is unauthenticated for the same reason).
 */

/** Same charset the link grammar accepts, so a junk value 400s before any fetch. */
const HANDLE_RE = /^[a-z0-9_]{3,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,100}$/;

export const invitesRouter: IRouter = Router();

invitesRouter.get(
  "/details",
  asyncHandler(async (req: Request, res: Response) => {
    const slugOrToken = String(req.query.slugOrToken ?? "").trim();
    const type = String(req.query.type ?? "").trim();

    if (type !== "community" && type !== "group") {
      throw new BadRequestError("INVALID_INVITE_TYPE");
    }
    const valid =
      type === "community"
        ? HANDLE_RE.test(slugOrToken.toLowerCase())
        : TOKEN_RE.test(slugOrToken);
    if (!valid) throw new BadRequestError("INVALID_INVITE_TARGET");

    if (type === "community") {
      const handle = slugOrToken.toLowerCase();
      const card = await fetchPublicCommunityCard(handle);
      if (!card) throw new NotFoundError("COMMUNITY_NOT_FOUND");
      return res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            type: "community" as const,
            id: card.communityId,
            name: card.name,
            description: card.description,
            avatarUrl: card.avatarUrl,
            bannerUrl: card.bannerUrl,
            memberCount: card.memberCount,
            deeplinkUrl: `${env.APP_SCHEME}://resolve?handle=${encodeURIComponent(handle)}`,
          },
          "OK"
        )
      );
    }

    const card = await fetchGroupInviteCard(slugOrToken);
    if (!card) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");
    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          type: "group" as const,
          id: card.groupId,
          name: card.name,
          description: card.description,
          avatarUrl: card.avatarUrl,
          bannerUrl: null,
          memberCount: card.memberCount,
          deeplinkUrl: `${env.APP_SCHEME}://joingroup?token=${encodeURIComponent(slugOrToken)}`,
        },
        "OK"
      )
    );
  })
);

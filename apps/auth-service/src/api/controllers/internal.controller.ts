import type { Request, Response } from "express";

import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { prisma } from "../../config/prisma.js";

/**
 * GET /api/internal/accounts?userIds=id1,id2,...
 * Returns { userId, account } for each requested userId.
 * Used by chat-service to resolve senderName when user-service has no profile yet.
 */
export const getAccountsByUserIds = asyncHandler(
  async (req: Request, res: Response) => {
    const raw = req.query["userIds"];
    const userIds =
      typeof raw === "string" && raw.length > 0
        ? raw.split(",").filter(Boolean).slice(0, 500)
        : [];

    if (userIds.length === 0) {
      return res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ accounts: [] }, "ok"));
    }

    const users = await prisma.authUser.findMany({
      where: { id: { in: userIds } },
      select: { id: true, account: true },
    });

    const accounts = users.map((u) => ({ userId: u.id, account: u.account }));
    return res.status(HTTP_STATUS.OK).json(new ApiResponse({ accounts }, "ok"));
  }
);

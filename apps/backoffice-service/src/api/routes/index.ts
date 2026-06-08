import { Router, type IRouter } from "express";

import { authRoutes } from "./auth.routes.js";
import { dashboardRoutes } from "./dashboard.routes.js";
import { livestreamRoutes } from "./livestream.routes.js";
import { meRoutes } from "./me.routes.js";
import { communityRoutes } from "./community.routes.js";
import { groupRoutes } from "./groups.routes.js";
import { moderationRoutes } from "./moderation.routes.js";
import { usersRoutes } from "./users.routes.js";

/** API v1 routes — mounted at `/v1` (gateway proxies /admin/* → :3010/v1/*). */
export const serviceRoutes: IRouter = Router();

serviceRoutes.use("/auth", authRoutes);
serviceRoutes.use("/me", meRoutes);
// Reports & Moderation routes are self-prefixed with `/reports` so they resolve
// at `/v1/reports/*` — matching the documented gateway path `/admin/v1/reports`
// (the gateway strips `/admin` and forwards `/v1/*` verbatim). Do NOT nest under
// `/moderation`, or `/admin/v1/reports` 404s.
serviceRoutes.use(moderationRoutes);
// User Management routes are self-prefixed with `/users` so they resolve at
// `/v1/users/*` — matching the documented gateway path `/admin/v1/users` (the
// gateway strips `/admin` and forwards `/v1/*` verbatim). Self-prefixed, NOT
// nested under a base path — same as moderation/livestreams.
serviceRoutes.use(usersRoutes);
// Livestream Management routes are self-prefixed with `/livestreams` so they
// resolve at `/v1/livestreams/*` — matching the documented gateway path
// `/admin/v1/livestreams` (the gateway strips `/admin` and forwards `/v1/*`
// verbatim). Self-prefixed, NOT nested under a base path — same as moderation.
serviceRoutes.use(livestreamRoutes);
// Community Management routes are self-prefixed with `/communities` so they
// resolve at `/v1/communities/*` — matching the documented gateway path
// `/admin/v1/communities` (the gateway strips `/admin` and forwards `/v1/*`
// verbatim). Self-prefixed, NOT nested under a base path — same as moderation.
serviceRoutes.use(communityRoutes);
// Group Management routes are self-prefixed with `/groups` so they resolve at
// `/v1/groups/*` — matching the documented gateway path `/admin/v1/groups` (the
// gateway strips `/admin` and forwards `/v1/*` verbatim). Self-prefixed, NOT
// nested under a base path — same as community.
serviceRoutes.use(groupRoutes);
serviceRoutes.use("/dashboard", dashboardRoutes);

const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const forbidden = {
  description: "Caller is not a platform admin (PLATFORM_ADMIN_REQUIRED)",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const validationError = {
  description: "Query validation failed (e.g. no filter/pagination param)",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

export const communityPaths = {
  "/communities": {
    post: {
      tags: ["Communities"],
      operationId: "createCommunity",
      summary: "Create a community",
      description:
        "Creator becomes ADMIN (memberCount starts at 1). `handle` is the unique @-slug (lowercase). Optional `memberIds` (UUIDs) are added as ACTIVE members. Upload an avatar via `POST /api/v1/media/upload-url` (category: `COMMUNITY_AVATAR`) first, then pass the returned object key as `avatarObjectKey`.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateCommunityRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Community created",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or invalid category",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "409": {
          description: "Community name or handle already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "bulkDeleteCommunities",
      summary: "Bulk remove communities from my list",
      description:
        "Remove multiple communities from the caller's own community list in a single call. Each community is processed independently — a failure for one does not block the others.\n\n" +
        "**Rules (per community):**\n" +
        "- `REMOVED` — caller was an active non-admin member and has been removed (reuses the same leave workflow, cleanup, and events as `POST /communities/{id}/leave`), **or** caller is a banned member (membership is left untouched — banned members are already excluded from `GET /communities/mine`, so the community was already invisible in the caller's list).\n" +
        "- `SKIPPED` — caller has no membership, already left, or is only pending — there is nothing to remove.\n" +
        "- `FAILED / OWNER_CANNOT_DELETE` — caller owns this community. Transfer ownership or delete the community from the admin panel.\n" +
        "- `FAILED / NOT_FOUND` — community does not exist.\n\n" +
        "Unlike bulk-leave, an admin's community is **never** auto-deleted here, even if the admin is the sole member.\n\n" +
        "A `MEMBER_LEFT` audit entry and a `community.member_left` RabbitMQ event are fired for each successful active-member removal. " +
        "The response is always `200 OK`; inspect each item's `status` and the `summary` to determine overall outcome.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkDeleteCommunityRequest" },
            examples: {
              basic: {
                summary: "Remove two communities",
                value: {
                  communityIds: [
                    "64a7b1e2f1d2e34567890abc",
                    "64a7b1e2f1d2e34567890def",
                  ],
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Bulk delete processed. Each item carries its own `status`; `summary` gives aggregate counts.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/BulkDeleteCommunityResult",
                      },
                    },
                  },
                ],
              },
              examples: {
                partial: {
                  summary: "Mixed result — one removed, one owner-blocked",
                  value: {
                    success: true,
                    message: "Bulk community removal processed",
                    data: {
                      results: [
                        {
                          communityId: "64a7b1e2f1d2e34567890abc",
                          status: "REMOVED",
                        },
                        {
                          communityId: "64a7b1e2f1d2e34567890def",
                          status: "FAILED",
                          errorCode: "OWNER_CANNOT_DELETE",
                        },
                      ],
                      summary: { requested: 2, removed: 1, failed: 1 },
                    },
                  },
                },
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },
  "/communities/categories": {
    get: {
      tags: ["Communities"],
      operationId: "listCommunityCategories",
      summary: "List community categories (active only)",
      description:
        "Active categories sorted by order then name. For mobile clients.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      responses: {
        "200": {
          description: "Categories",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CategoryListResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
    post: {
      tags: ["Communities — Admin Categories"],
      operationId: "createCommunityCategory",
      summary: "Create a community category",
      description:
        "Admin: create a new community category. The `slug` is auto-derived from `name`. Returns the created category with `visible` (mapped from `active`) flag.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: {
                  type: "string",
                  minLength: 2,
                  maxLength: 80,
                  example: "Technology",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Category created",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/AdminCategoryData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        "409": {
          description: "Category name already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/categories/admin": {
    get: {
      tags: ["Communities — Admin Categories"],
      operationId: "adminListAllCategories",
      summary: "List all categories (admin)",
      description:
        "Paginated list of all community categories including hidden ones. Filter by `status=visible|hidden|all` (default `all`). Search by name with `?search=`. Results include `visible` flag (mapped from the `active` field). " +
        "IMPORTANT — despite the `/admin` path segment, this is a community-service endpoint secured with the standard user `bearerAuth` access token (the same one used by every other `/communities/*` route), NOT the backoffice `adminBearerAuth` admin-panel token. " +
        'The caller must be an AIMess user whose access token carries the platform `role: "ADMIN"` claim (set at login for GlobalRole ADMIN accounts). A backoffice admin-panel session token will fail signature verification here with 401 `Invalid access token.`, because backoffice-service signs its tokens with a separate `JWT_ADMIN_SECRET`. ' +
        "For the admin-panel-authenticated equivalent, see `GET /admin/v1/categories` instead, which proxies to this data via gRPC.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["visible", "hidden", "all"],
            default: "all",
          },
          description:
            "Filter by visibility. `all` returns both visible and hidden.",
        },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1 },
          description: "Case-insensitive name search.",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Paginated category list",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/AdminCategoryListResult",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
      },
    },
  },
  "/communities/categories/{categoryId}": {
    patch: {
      tags: ["Communities — Admin Categories"],
      operationId: "updateCommunityCategory",
      summary: "Update a community category",
      description:
        "Admin: update a category's `name` and/or `visible` flag. At least one field must be provided. Updating `name` regenerates the `slug`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "categoryId",
          in: "path",
          required: true,
          schema: {
            type: "string",
            pattern: "^[a-f0-9]{24}$",
            example: "664f1a2b3c4d5e6f7a8b9c0d",
          },
          description: "MongoDB ObjectId of the category.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              minProperties: 1,
              properties: {
                name: {
                  type: "string",
                  minLength: 2,
                  maxLength: 80,
                  example: "Science & Nature",
                },
                visible: {
                  type: "boolean",
                  description: "true = visible to users; false = hidden.",
                  example: false,
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Category updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/AdminCategoryData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        "404": {
          description: "Category not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Category name already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities — Admin Categories"],
      operationId: "deleteCommunityCategory",
      summary: "Delete a community category",
      description:
        "Admin: hard-delete a category. Returns 409 if any active community still uses this category.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "categoryId",
          in: "path",
          required: true,
          schema: {
            type: "string",
            pattern: "^[a-f0-9]{24}$",
            example: "664f1a2b3c4d5e6f7a8b9c0d",
          },
          description: "MongoDB ObjectId of the category.",
        },
      ],
      responses: {
        "200": {
          description: "Category deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        "404": {
          description: "Category not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Category is in use by one or more communities",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/name-available": {
    get: {
      tags: ["Communities"],
      operationId: "checkCommunityNameAvailability",
      summary: "Check community name availability",
      description: "Case-insensitive. Redis-cached.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "name",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 3, maxLength: 50 },
        },
      ],
      responses: {
        "200": {
          description: "Availability result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityNameAvailabilityData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },
  "/communities/handle-available": {
    get: {
      tags: ["Communities"],
      operationId: "checkCommunityHandleAvailability",
      summary: "Check community handle availability",
      description: "Case-insensitive. Redis-cached.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "handle",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 3, maxLength: 32 },
        },
      ],
      responses: {
        "200": {
          description: "Availability result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityHandleAvailabilityData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },
  "/communities/by-handle/{handle}": {
    get: {
      tags: ["Communities"],
      operationId: "resolveCommunityByHandle",
      summary: "Resolve a public community by handle (deep-link)",
      description:
        "Public deep-link resolver for `https://aimess.me/<handle>` (Community " +
        "Sharing & Deep-Linking). **PUBLIC communities only** — a private " +
        "community's handle returns 404, so this surface never reveals a private " +
        "community. Suspended/soft-deleted communities also return 404. A banned " +
        "caller gets 403. Drives the client's Join preview screen.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "handle",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 3, maxLength: 32 },
        },
      ],
      responses: {
        "200": {
          description: "Public community resolved",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/PublicCommunityResponse",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Malformed handle (INVALID_HANDLE)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is banned (COMMUNITY_JOIN_BANNED)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Not found / private / suspended (COMMUNITY_NOT_FOUND)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/mine": {
    get: {
      tags: ["Communities"],
      operationId: "listMyCommunities",
      summary: "List my communities (joined) / search communities",
      description:
        "Unified communities list. The mode is inferred from the params — there " +
        "is no `scope` flag. All params are optional: omitting `before_ts`, " +
        "`after_ts`, `q`, and `categoryId` returns the default **search mode** page " +
        "(PUBLIC + joined PRIVATE, `filter=all`, page 1). The only mutually-exclusive " +
        "rule is that `before_ts` and `after_ts` cannot both be sent (→ 400).\n\n" +
        "**Joined mode** (`before_ts` or `after_ts` present) — communities where " +
        "you are an ACTIVE member, ordered by `lastActivityAt` (latest community " +
        "message, else createdAt). Timestamp-cursor pagination: `before_ts` " +
        "returns items with `lastActivityAt <= before_ts` (newest-first); " +
        "`after_ts` returns items with `lastActivityAt >= after_ts` (oldest-first); " +
        "mutually exclusive. Boundaries are inclusive (consecutive pages can share " +
        "the boundary item — de-duplicate by `id`). Page with " +
        "`pagination.nextCursor` (epoch-ms) fed back as the same param. Pagination " +
        "takes precedence over `q`/`categoryId` if both are sent. Returns " +
        "`MyCommunitiesResponseData`.\n\n" +
        "**Search mode** (`q` and/or `categoryId`, no pagination) — communities " +
        "matching the filters across **PUBLIC communities PLUS any PRIVATE " +
        "community you are already an ACTIVE member of** (joined communities are " +
        "NOT excluded). Optional `q` searches name and handle (case-insensitive); " +
        "optional `categoryId` filters by category. `filter` defaults to `all`; " +
        "`live`/`upcoming` are reserved for livestream discovery and currently " +
        "return an empty page. Newest-first offset/page pagination (`page` + " +
        "`limit`). Returns `CommunityDiscoverResponseData`.\n\n" +
        "All datetime response fields are epoch milliseconds (number). (The legacy " +
        "`GET /communities/discover` endpoint is a deprecated alias for search " +
        "with the original 'exclude joined' filtering.)\n\n" +
        "**Community-chat fields (both modes).** Every item carries " +
        "`unreadMessageCount` (integer, default 0) and `lastMessageActivity` " +
        "(object or null). These are **member-only**: a real unread count and " +
        "last-message preview are returned only for communities you are an ACTIVE " +
        "member of; for any non-member community surfaced by search mode they are " +
        "`0` / `null`. `lastMessageActivity` is `{ username, message, dateTime }` " +
        "where `dateTime` is **epoch milliseconds** and `message` is a list-screen " +
        "preview (text content, or a placeholder like '📷 Photo' for media). If " +
        "chat-service is unavailable the endpoint degrades gracefully (all items " +
        "get `0` / `null`).\n\n" +
        "**Mute field notes (joined mode `CommunityListItem`):**\n" +
        "- `isMuted` — caller's self-service **notification mute** (mute-bell / " +
        '"Mute Notifications"; silences pushes). There is no `notificationsMuted` ' +
        "alias — use `isMuted` only.\n" +
        "- `muteUntil` — when that notification mute expires (ISO-8601). " +
        "`null` = not muted OR muted indefinitely — use `isMuted` to disambiguate.\n" +
        "- `isMemberMuted` — **moderation mute**: an admin/mod silenced the caller " +
        "(can still read, cannot post). Not the mute-bell toggle.\n" +
        "- `memberMutedUntil` — when that moderation mute expires. " +
        "`null` = indefinite when `isMemberMuted` is true, or not muted.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "before_ts",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1 },
          description:
            "Joined mode. Epoch ms. Returns items with lastActivityAt <= before_ts (newest-first).",
        },
        {
          name: "after_ts",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1 },
          description:
            "Joined mode. Epoch ms. Returns items with lastActivityAt >= after_ts (oldest-first).",
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 100 },
          description:
            "Search mode. Search term matched against community name and handle (case-insensitive).",
        },
        {
          name: "categoryId",
          in: "query",
          required: false,
          schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
          description:
            "Search mode. Filter to a single category (24-char hex ObjectId).",
        },
        {
          name: "filter",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["all", "live", "upcoming"],
            default: "all",
          },
          description:
            "Search mode. `all` browses every matching community. " +
            "`live`/`upcoming` are reserved for livestream filtering and currently return an empty page.",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "Search mode. 1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description:
            "My communities (joined mode) or matching communities (search mode)",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        oneOf: [
                          {
                            $ref: "#/components/schemas/MyCommunitiesResponseData",
                          },
                          {
                            $ref: "#/components/schemas/MyCommunitiesSearchResponseData",
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },
  "/communities/liked": {
    get: {
      tags: ["Communities"],
      operationId: "listLikedCommunities",
      summary: "List liked (favorited) communities",
      description:
        "Returns the caller's saved/liked communities, newest-first by `likedAt`. ObjectId cursor pagination — pass `cursor` (the `nextCursor` from the previous page) on subsequent calls.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
          description:
            "Pagination cursor (ObjectId of the last item from the previous page).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Liked communities page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/LikedCommunitiesResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/communities/discover": {
    get: {
      tags: ["Communities"],
      operationId: "discoverCommunities",
      summary: "Discover / search / browse public communities (deprecated)",
      deprecated: true,
      description:
        "**Deprecated** — use `GET /communities/mine` with `q`/`categoryId` instead. " +
        "Public communities you are not already in (active, pending, and banned memberships are excluded). Optional `q` searches name and handle (case-insensitive); optional `categoryId` filters by category. `filter` defaults to `all`; `live` and `upcoming` are reserved for livestream-based discovery and currently return an empty page (no stream-service yet). Newest-first, offset/page pagination (`page` + `limit`); response carries `pagination` and `data`. `createdAt` in each item is now epoch milliseconds (filtering is unchanged).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 100 },
          description: "Search term matched against community name and handle.",
        },
        {
          name: "categoryId",
          in: "query",
          required: false,
          schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
          description: "Filter to a single category (24-char hex ObjectId).",
        },
        {
          name: "filter",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["all", "live", "upcoming"],
            default: "all",
          },
          description:
            "`all` browses every public community. `live`/`upcoming` are reserved for livestream filtering and currently return an empty page.",
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Discovered communities",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityDiscoverResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/communities/{id}": {
    get: {
      tags: ["Communities"],
      operationId: "getCommunity",
      summary: "Get a community",
      description:
        "Returns the community with its category, member count, your role (`role`, null if not a member), and presigned avatar/cover URLs.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Community",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Communities"],
      operationId: "updateCommunity",
      summary: "Update a community",
      description:
        "Admin only. Partial update; name/handle re-checked for uniqueness (excluding this community). " +
        "Optionally supply memberIds (uuid[]) with the complete desired member list — the service diffs it against current ACTIVE members and applies adds/removes automatically.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateCommunityRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Community updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or invalid category",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Community name or handle already taken",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "deleteCommunity",
      summary: "Delete a community",
      description:
        "Admin only. Soft-deletes the community (Telegram/Discord-style — works even when other ACTIVE members are still present), bulk-marks every remaining ACTIVE member as LEFT, zeros memberCount, audits `COMMUNITY_DELETED`, and invalidates the name/handle availability caches. Subsequent reads of this community return 404.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Community deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members": {
    get: {
      tags: ["Communities"],
      operationId: "listCommunityMembers",
      summary: "List community members",
      description:
        "Any ACTIVE member (any role) may view the roster. Offset/page pagination (`page` + `limit`); response carries `pagination` and `data`. Optional `status` filter defaults to ACTIVE.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["ACTIVE", "PENDING", "BANNED", "LEFT"],
            default: "ACTIVE",
          },
        },
      ],
      responses: {
        "200": {
          description: "Community members",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMembersResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an active member of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    post: {
      tags: ["Communities"],
      operationId: "addCommunityMembers",
      summary: "Add members",
      description:
        "Moderator or admin only. Adds 1–100 users as ACTIVE members and recomputes memberCount. Users already ACTIVE are skipped (`ALREADY_MEMBER`); BANNED users are skipped (`BANNED`, unban first); previously-LEFT users are reactivated as MEMBER; the rest are created as MEMBER. The response lists `added` and `skipped`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AddMembersRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Members processed (added / skipped)",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/AddMembersResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community moderator/admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/audit-logs": {
    get: {
      tags: ["Communities"],
      operationId: "listCommunityAuditLogs",
      summary: "List community audit logs",
      description:
        "Moderator or admin only. Returns the moderation audit trail (promote/demote, kick, ban, unban, admin transfer), newest first. Offset/page pagination (`page` + `limit`); response carries `pagination` and `data`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Community audit logs",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityAuditLogsResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community moderator/admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/leave": {
    post: {
      tags: ["Communities"],
      operationId: "leaveCommunity",
      summary: "Leave a community",
      description:
        "Leave a community you are an ACTIVE member of (status set to LEFT) and recompute memberCount. Optional `reason` + `reasonText` body is recorded in a `MEMBER_LEFT` audit row. If the admin leaves, ownership is auto-handed off in this order: 1) the longest-tenured ACTIVE moderator, 2) the longest-tenured ACTIVE plain member, 3) if the admin is the only active member, the community is soft-deleted (audited `COMMUNITY_DELETED`). The response is always the leaving member's DTO (status LEFT).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LeaveCommunityRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Left the community",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Community not found, or you are not an active member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/me": {
    delete: {
      tags: ["Communities"],
      operationId: "deleteCommunityForSelf",
      summary: "Remove this community from my list",
      description:
        "Removes this community from the caller's own account only. Distinct from `DELETE /communities/{id}` (admin hard-delete of the whole community).\n\n" +
        "**Rules:**\n" +
        "- Active non-admin member → same leave workflow as `POST /communities/{id}/leave` (status LEFT, events/audit).\n" +
        "- Banned member → idempotent success (membership left untouched; community already hidden from `/communities/mine`).\n" +
        "- Owner/admin → **400** `COMMUNITY_OWNER_CANNOT_DELETE` (transfer ownership or use admin delete).\n" +
        "- No membership / already left → **404**.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Community removed from caller's list (`data` is null).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "400": {
          description: "Caller owns this community and cannot self-delete it",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description:
            "Community not found or caller has no removable membership",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/like": {
    post: {
      tags: ["Communities"],
      operationId: "likeCommunity",
      summary: "Like (favorite) a community",
      description:
        "Adds the community to the caller's liked list. Idempotent — liking an already-liked community returns the existing favorite row unchanged. The community must exist and must not be suspended.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "201": {
          description: "Community liked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityFavoriteData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "unlikeCommunity",
      summary: "Unlike (un-favorite) a community",
      description:
        "Removes the community from the caller's liked list. No-op if the community was not liked. The community must exist.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Community unliked (data is null)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join": {
    post: {
      tags: ["Communities"],
      operationId: "joinCommunity",
      summary: "Join a community",
      description:
        "Self-join a community. For PUBLIC communities the caller becomes an ACTIVE member immediately (HTTP 201, `data.status: JOINED`). For PRIVATE communities a PENDING join request is created and admins/mods are notified (HTTP 201, `data.status: REQUEST_CREATED`). " +
        "Calling again when already ACTIVE returns 200 with `data.status: ALREADY_MEMBER` (idempotent, no write). " +
        "Previously-LEFT members of a PUBLIC community are reactivated (joinedAt preserved, snapshot refreshed, role forced to MEMBER, audited `COMMUNITY_JOINED` with `{ reactivated: true }`). " +
        "BANNED members cannot rejoin (403). Suspended communities return 403.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "201": {
          description:
            "Joined (PUBLIC) or join request created (PRIVATE). Discriminated by `data.status`.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        oneOf: [
                          {
                            $ref: "#/components/schemas/CommunityJoinedResponse",
                          },
                          {
                            $ref: "#/components/schemas/CommunityJoinRequestCreatedResponse",
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "200": {
          description: "Already an active member (idempotent).",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityAlreadyMemberResponse",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "User is banned from this community, or the community is suspended.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/transfer-admin": {
    post: {
      tags: ["Communities"],
      operationId: "transferCommunityAdmin",
      summary: "Transfer community admin to another member",
      description:
        'Admin only. Promotes the target ACTIVE member to ADMIN, transfers community ownership, and demotes the caller to MEMBER (caller stays ACTIVE — Telegram-style hand-off). Audited as `ADMIN_TRANSFERRED` with `{ reason: "explicit_transfer" }`. Target must be an ACTIVE non-admin member; you cannot transfer to yourself.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TransferAdminRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Admin transferred — community DTO reflects new admin",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot transfer to yourself, or target is already an admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/close": {
    post: {
      tags: ["Communities"],
      operationId: "closeCommunity",
      summary: "Close a community (owner lifecycle)",
      description:
        "Community ADMIN (owner) only. Sets `status` to CLOSED: ALL members (including the admin) are auto-removed (`memberCount → 0`), the community chat room is suspended (read-only), and a realtime `community:closed` event is broadcast to the `community:<id>` room and to every ex-member's `user:<id>` room so connected clients disable actions immediately. Reversible via `POST /communities/{id}/reopen` — distinct from `DELETE /communities/{id}` (permanent). Idempotent: closing an already-CLOSED community is a no-op.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  maxLength: 500,
                  description:
                    "Optional free-text reason surfaced to evicted members.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Community closed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reopen": {
    post: {
      tags: ["Communities"],
      operationId: "reopenCommunity",
      summary: "Reopen a closed community (owner lifecycle)",
      description:
        "Community owner only (authorized by `adminId`, NOT active membership — the owner left the roster on close). Sets `status` back to ACTIVE, re-establishes the owner as the sole ACTIVE ADMIN (`memberCount → 1`), unsuspends the chat room, and broadcasts a realtime `community:reopened` event. Former members are NOT restored — they re-join via the normal join flow. Returns the updated community DTO. Idempotent: reopening an already-open community returns its current state.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Community reopened — returns the updated community DTO",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not the community owner",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}/role": {
    put: {
      tags: ["Communities"],
      operationId: "updateCommunityMemberRole",
      summary: "Promote or demote a member",
      description:
        "Admin only. Set a member's role to MODERATOR or MEMBER (ADMIN cannot be assigned). You cannot change your own role or the community admin's role. Idempotent when the member already has the target role.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateMemberRoleRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Member role updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot modify self, or cannot modify the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}": {
    delete: {
      tags: ["Communities"],
      operationId: "kickCommunityMember",
      summary: "Kick a member",
      description:
        "Moderator or admin only. Removes an ACTIVE member (status set to LEFT) and recomputes memberCount. You cannot kick yourself or the community admin, and you must outrank the target (a moderator cannot kick another moderator).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  maxLength: 500,
                  description:
                    "Optional moderation reason — persisted to the community moderation audit log (see GET /communities/{id}/audit-logs).",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Member removed",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot modify self, or cannot modify the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin, or does not outrank the target",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}/ban": {
    post: {
      tags: ["Communities"],
      operationId: "banCommunityMember",
      summary: "Ban a member",
      description:
        "Admin only. Sets the member's status to BANNED and recomputes memberCount. You cannot ban yourself or the community admin. Idempotent when the member is already banned. " +
        "Posts a PERSONAL `MEMBER_BANNED` system message ('You were banned from this community.') visible only to the banned " +
        "user's own chat history — silent for everyone else. The banned member keeps read access to their pre-ban chat " +
        "history (via GET /chat/community/rooms/{roomId}/messages and the sync endpoint) but never sees anything created " +
        "after the ban.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  maxLength: 500,
                  description:
                    "Optional moderation reason — persisted to the community moderation audit log (see GET /communities/{id}/audit-logs).",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Member banned",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot modify self, or cannot modify the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "unbanCommunityMember",
      summary: "Unban a member",
      description:
        "Admin only. Lifts a ban: a BANNED member's status is set to LEFT (they are not auto-re-added — add them back or let them re-join to become ACTIVE again). The community is NOT removed from the target's `/communities/mine` list — it stays visible (read-only, zero access) exactly as it was while banned, until the target explicitly removes it themselves. memberCount is recomputed. Fails if the member is not currently banned.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Member unbanned",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed, or the member is not banned",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/muted-members": {
    get: {
      tags: ["Communities"],
      operationId: "listMutedCommunityMembers",
      summary: "List moderation-muted members",
      description:
        "Moderator or admin only. Offset/page pagination (`page` + `limit`); response carries `pagination` and `data`. Fully-expired mutes are excluded (lazy expiration — a row whose `mutedUntil` is in the past is treated as not muted).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Muted members",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMutedMembersResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin (caller lacks MODERATOR rank)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/banned-members": {
    get: {
      tags: ["Communities"],
      operationId: "listBannedCommunityMembers",
      summary: "List banned members",
      description:
        "Moderator or admin only. Returns the community's **currently-banned** members (status === BANNED). Lifted bans are not included here — the full ban history is in the moderation audit log (GET /communities/{id}/audit-logs). Offset/page pagination (`page` + `limit`); response carries `pagination` and `data`. Supports free-text `search` (matches displayName / username / userId) and `sortBy` + `sortOrder` (default: bannedAt desc = newest first).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "search",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description:
            "Case-insensitive search across displayName, username, and userId.",
        },
        {
          name: "sortBy",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["bannedAt", "displayName", "username"],
            default: "bannedAt",
          },
        },
        {
          name: "sortOrder",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["asc", "desc"],
            default: "desc",
          },
          description:
            "With sortBy=bannedAt: desc = newest first, asc = oldest first.",
        },
      ],
      responses: {
        "200": {
          description: "Banned members",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityBannedMembersResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin (caller lacks MODERATOR rank)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/banned-members/{userId}/unban": {
    post: {
      tags: ["Communities"],
      operationId: "unbanFromBannedList",
      summary: "Unban a member (banned-members section)",
      description:
        "Admin only. Dedicated unban action for the banned-members section — functionally identical to DELETE /communities/{id}/members/{userId}/ban. Lifts a ban (BANNED → LEFT; not auto-re-added — the target stays a non-member until they rejoin) without removing the community from the target's `/communities/mine` list, records a MEMBER_UNBANNED audit entry, emits the `community:member:unbanned` socket event, and notifies the unbanned user. Fails if the member is not currently banned.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Member unbanned",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed, or the member is not banned",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not a community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}/mute": {
    post: {
      tags: ["Communities"],
      operationId: "muteCommunityMember",
      summary: "Mute a member",
      description:
        "Moderator or admin only. Upserts a moderation mute on an ACTIVE member. `durationMinutes` null/omitted → mute indefinitely; positive integer → mute for N minutes. You cannot mute yourself or the community admin, and you must outrank the target (a moderator cannot mute another moderator). Recorded in the community moderation audit log (`MEMBER_MUTED`). " +
        "Posts a PERSONAL `MEMBER_MUTED` system message ('You are muted until {{date}}' or 'You are muted indefinitely') " +
        "visible only in the muted user's own chat history — silent for everyone else (COMMUNITY-wide, no line for other members).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SetMemberMuteRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Member muted",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMutedMemberData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot modify self, or cannot modify the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin, or does not outrank the target",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "unmuteCommunityMember",
      summary: "Unmute a member",
      description:
        "Moderator or admin only. Removes an active moderation mute. Fails when the member is not currently muted (a fully-expired mute is treated as not muted). Recorded in the community moderation audit log (`MEMBER_UNMUTED`). " +
        "Retracts (soft-deletes) the target's still-visible 'You are muted until …' PERSONAL line from their own history, and " +
        "posts a PERSONAL `MEMBER_UNMUTED` system message ('You were unmuted') visible only to that member — silent for " +
        "everyone else.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Member unmuted (data is null)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin (caller lacks MODERATOR rank)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found, or the member is not muted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}/warn": {
    post: {
      tags: ["Communities"],
      operationId: "warnCommunityMember",
      summary: "Warn a member",
      description:
        "Moderator or admin only. Appends a warning (with a required note) to an ACTIVE member. Warnings are append-only — a member may have multiple. You cannot warn yourself or the community admin, and you must outrank the target. Recorded in the community moderation audit log (`MEMBER_WARNED`).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/WarnMemberRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Member warned",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberWarningData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed, cannot modify self, or cannot modify the community admin",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin, or does not outrank the target",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/members/{userId}/warnings": {
    get: {
      tags: ["Communities"],
      operationId: "listCommunityMemberWarnings",
      summary: "List a member's warnings",
      description:
        "Moderator or admin only. Offset/page pagination (`page` + `limit`); response carries `pagination` and `data`, newest first.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
          description: "User ID of the target member.",
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-based page number.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Member warnings",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityMemberWarningsResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Not a community moderator/admin (caller lacks MODERATOR rank)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/join-requests/mine": {
    get: {
      tags: ["Communities"],
      operationId: "listMyJoinRequests",
      summary: "List the caller's join requests",
      description:
        "Caller's own join requests across communities. Filter by status (PENDING/APPROVED/REJECTED/CANCELLED). Each row embeds a `community` summary; rows whose community has been soft-deleted are filtered out (totalData is best-effort).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
          },
        },
      ],
      responses: {
        "200": {
          description: "Caller's join requests page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/MyJoinRequestPage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/communities/invites/mine": {
    get: {
      tags: ["Communities"],
      operationId: "listMyInvites",
      summary: "List the caller's invites",
      description:
        "Invites where the caller is the invitee. Filter by status (PENDING/ACCEPTED/DECLINED/EXPIRED). Each row embeds a `community` summary; rows whose community has been soft-deleted are filtered out (totalData is best-effort).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"],
          },
        },
      ],
      responses: {
        "200": {
          description: "Caller's invites page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/MyInvitePage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/communities/reports/mine": {
    get: {
      tags: ["Communities"],
      operationId: "listMyReports",
      summary: "List the caller's reports",
      description:
        "Caller's own reports across communities. Filter by status (OPEN/REVIEWED/ACTIONED/DISMISSED/WITHDRAWN). Each row embeds a `community` summary; rows whose community has been soft-deleted are filtered out (totalData is best-effort).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["OPEN", "REVIEWED", "ACTIONED", "DISMISSED", "WITHDRAWN"],
          },
        },
      ],
      responses: {
        "200": {
          description: "Caller's reports page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/MyReportPage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
      },
    },
  },
  "/communities/invites/{inviteId}/accept": {
    post: {
      tags: ["Communities"],
      operationId: "acceptCommunityInvite",
      summary: "Accept an invite",
      description:
        "Invitee only. Adds the caller as an ACTIVE member (or reactivates a LEFT row) and marks the invite ACCEPTED. Idempotent on already-ACCEPTED.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "inviteId",
          in: "path",
          required: true,
          description:
            "Invite ID from GET /communities/invites/mine or GET /communities/{id}/invites.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Invite accepted",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/InviteAcceptedData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invite is no longer pending",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not the invitee, or the caller is banned from the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Invite or community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/invites/{inviteId}/decline": {
    post: {
      tags: ["Communities"],
      operationId: "declineCommunityInvite",
      summary: "Decline an invite",
      description: "Invitee only. Marks the invite DECLINED. No member write.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "inviteId",
          in: "path",
          required: true,
          description:
            "Invite ID from GET /communities/invites/mine or GET /communities/{id}/invites.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Invite declined",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/InviteData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invite is no longer pending",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not the invitee",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Invite not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests": {
    post: {
      tags: ["Communities"],
      operationId: "submitJoinRequest",
      summary: "Submit a join request",
      description:
        "PRIVATE communities only. If a PENDING invite already exists for the caller, this auto-accepts the invite (returns `InviteAcceptedData` with status 200) instead of creating a new request.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateJoinRequestRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Join request created",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/JoinRequestData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "200": {
          description:
            "Mutual want detected — pending invite auto-accepted, caller is now an ACTIVE member.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/InviteAcceptedData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or community is not PRIVATE",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is banned from the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "409": {
          description: "Caller is already an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    get: {
      tags: ["Communities"],
      operationId: "listCommunityJoinRequests",
      summary: "List a community's join requests",
      description:
        "Moderator or admin only. Default `status=PENDING`. Each row embeds a `user` snapshot.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
            default: "PENDING",
          },
        },
      ],
      responses: {
        "200": {
          description: "Join requests page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/JoinRequestPage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/{requestId}/approve": {
    post: {
      tags: ["Communities"],
      operationId: "approveJoinRequest",
      summary: "Approve a join request",
      description:
        "Moderator or admin only. Creates an ACTIVE member (or reactivates a LEFT row), marks the request APPROVED. Idempotent on already-APPROVED.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
          description:
            "Join request ID from GET /communities/{id}/join-requests.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Join request approved",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/JoinRequestApprovedData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Request is REJECTED or CANCELLED",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not a moderator/admin, or the requester is banned",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or join request not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/{requestId}/reject": {
    post: {
      tags: ["Communities"],
      operationId: "rejectJoinRequest",
      summary: "Reject a join request",
      description:
        "Moderator or admin only. PENDING-only — fails with 400 otherwise.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
          description:
            "Join request ID from GET /communities/{id}/join-requests.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Join request rejected",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/JoinRequestData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Request is not pending",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or join request not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/bulk-approve": {
    post: {
      tags: ["Communities"],
      operationId: "bulkApproveJoinRequests",
      summary: "Bulk approve join requests",
      description:
        "Moderator or admin only. Accepts up to 50 request IDs. Non-PENDING, not-found, and banned-requester IDs are silently skipped and returned in `skipped`. Idempotent per request — already-ACTIVE members are not re-created.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                requestIds: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 50,
                  description:
                    "Join request IDs to approve (duplicates deduplicated).",
                },
              },
              required: ["requestIds"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Bulk approve result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/BulkApproveJoinRequestsResult",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not a moderator/admin, or community is SUSPENDED",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/bulk-reject": {
    post: {
      tags: ["Communities"],
      operationId: "bulkRejectJoinRequests",
      summary: "Bulk reject join requests",
      description:
        "Moderator or admin only. Accepts up to 50 request IDs. Non-PENDING and not-found IDs are silently skipped and returned in `skipped`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                requestIds: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 50,
                  description:
                    "Join request IDs to reject (duplicates deduplicated).",
                },
              },
              required: ["requestIds"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Bulk reject result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/BulkRejectJoinRequestsResult",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/mine": {
    delete: {
      tags: ["Communities"],
      operationId: "cancelMyCommunityJoinRequest",
      summary: "Cancel my pending join request for this community",
      description:
        "Convenience alias for cancelling the caller's own PENDING join request without looking up the request id. Same outcome as `DELETE /communities/{id}/join-requests/{requestId}` when the request belongs to the caller. Returns 404 when no PENDING request exists for the caller.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Join request cancelled",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/JoinRequestData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Request is not pending",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "404": {
          description:
            "Community not found, or no pending join request for the caller",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/join-requests/{requestId}": {
    delete: {
      tags: ["Communities"],
      operationId: "cancelJoinRequest",
      summary: "Cancel your own join request",
      description:
        "Requester only. PENDING-only — fails with 400 otherwise. No audit recorded (user-initiated).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
          description:
            "Join request ID from GET /communities/{id}/join-requests.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Join request cancelled",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/JoinRequestData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Request is not pending",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not the requester",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or join request not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/invites": {
    post: {
      tags: ["Communities"],
      operationId: "bulkInviteToCommunity",
      summary: "Bulk-invite users to a community",
      description:
        "Moderator or admin only. Accepts 1–50 user IDs in a single request. Invalid users (banned, self, already member, already pending) are reported in the `results` array instead of failing the entire request. Notifications and socket events are fired only for users that receive a new or recycled invite.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateInviteRequest" },
            example: {
              userIds: [
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
              ],
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Bulk invite processed. Check `data.invited` for the number of new invites sent. A 201 is returned even when some users were skipped — inspect `data.results` for per-user outcomes.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/BulkInviteResult" },
                    },
                  },
                ],
              },
              example: {
                success: true,
                message: "Invites processed",
                data: {
                  totalRequested: 3,
                  invited: 1,
                  alreadyInvited: 1,
                  alreadyMembers: 1,
                  failed: 0,
                  results: [
                    {
                      userId: "11111111-1111-4111-8111-111111111111",
                      outcome: "INVITED",
                      inviteId: "aaaaaaaaaaaaaaaaaaaaaaaa",
                    },
                    {
                      userId: "22222222-2222-4222-8222-222222222222",
                      outcome: "ALREADY_INVITED",
                      inviteId: "bbbbbbbbbbbbbbbbbbbbbbbb",
                    },
                    {
                      userId: "33333333-3333-4333-8333-333333333333",
                      outcome: "ALREADY_MEMBER",
                    },
                  ],
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation failed — missing userIds, empty array, array exceeds 50 items, or one or more IDs are not valid UUIDs.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not a moderator/admin, or the community is closed/suspended.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    get: {
      tags: ["Communities"],
      operationId: "listCommunityInvites",
      summary: "List a community's invites",
      description:
        "Moderator or admin only. Each row embeds an `invitee` snapshot.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED"],
          },
        },
      ],
      responses: {
        "200": {
          description: "Invites page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/InvitePage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports": {
    post: {
      tags: ["Communities"],
      operationId: "submitCommunityReport",
      summary: "Submit a community report",
      description:
        "Any ACTIVE member may file a report. Omit `targetUserId` to report the community itself; otherwise the targeted user must currently have a member row (any status). For a message-level report, send `reportedMessageId` — the server resolves the message's text/media/posted-at from chat-service and snapshots it onto the report (populates the moderator card's \"Reported Content\"); resolution is best-effort. An existing OPEN report from the same reporter on the same (community, target) tuple is returned idempotently (still 201).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateReportRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Report submitted",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or caller targeted themselves",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not an ACTIVE member of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or target member not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    get: {
      tags: ["Communities"],
      operationId: "listCommunityReports",
      summary: "List a community's reports",
      description:
        "Moderator or admin only. Defaults to status=OPEN. Each row embeds `reporter` and (optional) `target` snapshots.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["OPEN", "REVIEWED", "ACTIONED", "DISMISSED", "WITHDRAWN"],
            default: "OPEN",
          },
        },
      ],
      responses: {
        "200": {
          description: "Reports page",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportPage" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports/{reportId}/review": {
    post: {
      tags: ["Communities"],
      operationId: "markReportReviewed",
      summary: "Mark a report as REVIEWED",
      description:
        "Moderator or admin only. Records `reviewedBy` + `reviewedAt` + optional `resolution`. Allowed only from OPEN.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          description: "Report ID from GET /communities/{id}/reports.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReportResolutionRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Report reviewed",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid status transition",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or report not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports/{reportId}/action": {
    post: {
      tags: ["Communities"],
      operationId: "markReportActioned",
      summary: "Mark a report as ACTIONED",
      description:
        "Moderator or admin only. Records `reviewedBy` + `reviewedAt` + optional `resolution`. Allowed from OPEN or REVIEWED. Terminal status.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          description: "Report ID from GET /communities/{id}/reports.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReportResolutionRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Report actioned",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid status transition",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or report not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports/{reportId}/dismiss": {
    post: {
      tags: ["Communities"],
      operationId: "markReportDismissed",
      summary: "Mark a report as DISMISSED",
      description:
        "Moderator or admin only. Records `reviewedBy` + `reviewedAt` + optional `resolution`. Allowed from OPEN or REVIEWED. Terminal status.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          description: "Report ID from GET /communities/{id}/reports.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReportResolutionRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Report dismissed",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid status transition",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or report not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports/{reportId}/withdraw": {
    post: {
      tags: ["Communities"],
      operationId: "withdrawCommunityReport",
      summary: "Withdraw your own report",
      description:
        "Reporter-only (the caller must be the original reporter). Allowed only while the report is OPEN. Terminal status WITHDRAWN with resolution `\"withdrawn_by_reporter\"`. Not audited (caller's intent didn't materialize).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          description: "Report ID from GET /communities/{id}/reports.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Report withdrawn (status WITHDRAWN)",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/ReportData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Report is no longer OPEN",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not the reporter",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Report not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/reports/{reportId}": {
    delete: {
      tags: ["Communities"],
      operationId: "deleteCommunityReport",
      summary: "Hard-delete a report",
      description:
        "Moderator or admin only. Permanently deletes the report row regardless of its current status. This is a destructive moderation action (distinct from the reporter self-withdraw at POST /communities/{id}/reports/{reportId}/withdraw) and is recorded in the community moderation audit log (`COMMUNITY_REPORT_DELETED`).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          description: "Report ID from GET /communities/{id}/reports.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Report deleted (data is null)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not a moderator or admin of the community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or report not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  // --- Mute settings -------------------------------------------------------
  "/communities/{id}/mute": {
    get: {
      tags: ["Communities"],
      operationId: "getCommunityMuteSetting",
      summary: "Get the caller's mute setting for a community",
      description:
        "ACTIVE-member only. Returns 404 (`COMMUNITY_NOT_MUTED`) when no mute row exists.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Mute setting",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityMuteData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found or caller has no mute row",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Communities"],
      operationId: "setCommunityMuteSetting",
      summary: "Set or update the caller's mute setting",
      description:
        "Upsert. ACTIVE-member only. `durationMinutes` null/omitted → mute indefinitely; positive integer → mute for N minutes.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SetMuteRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Mute setting updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/CommunityMuteData" },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    delete: {
      tags: ["Communities"],
      operationId: "clearCommunityMuteSetting",
      summary: "Clear the caller's mute setting",
      description: "Idempotent. ACTIVE-member only.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Mute cleared",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiSuccessResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  // --- Bulk leave -----------------------------------------------------------
  "/communities/leave/bulk": {
    post: {
      tags: ["Communities"],
      operationId: "bulkLeaveCommunities",
      summary: "Bulk leave communities",
      description:
        "Leave multiple communities in a single call. Each community is processed independently — a failure for one does not block the others.\n\n" +
        "**Rules (per community):**\n" +
        "- `LEFT` — caller was an active non-admin member and has been removed.\n" +
        "- `DELETED` — caller was the admin **and** the sole remaining member; the community is auto-deleted.\n" +
        "- `FAILED / ADMIN_CANNOT_LEAVE` — caller is admin and other members exist; transfer ownership first via `POST /communities/{id}/transfer-admin`.\n" +
        "- `FAILED / NOT_MEMBER` — caller is not an active member of this community.\n" +
        "- `FAILED / NOT_FOUND` — community does not exist or has been deleted.\n\n" +
        "A `MEMBER_LEFT` audit entry and a `community.member_left` RabbitMQ event are fired for each successful non-admin leave. " +
        "The response is always `200 OK`; inspect each item's `status` and the `summary` to determine overall outcome.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkLeaveRequest" },
            examples: {
              basic: {
                summary: "Leave two communities",
                value: {
                  communityIds: [
                    "64a7b1e2f1d2e34567890abc",
                    "64a7b1e2f1d2e34567890def",
                  ],
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Bulk leave processed. Each item carries its own `status`; `summary` gives aggregate counts.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/BulkLeaveResult" },
                    },
                  },
                ],
              },
              examples: {
                partial: {
                  summary: "Mixed result — one left, one admin-blocked",
                  value: {
                    success: true,
                    message: "Bulk community leave processed",
                    data: {
                      results: [
                        {
                          communityId: "64a7b1e2f1d2e34567890abc",
                          status: "LEFT",
                        },
                        {
                          communityId: "64a7b1e2f1d2e34567890def",
                          status: "FAILED",
                          errorCode: "ADMIN_CANNOT_LEAVE",
                        },
                      ],
                      summary: { requested: 2, left: 1, failed: 1 },
                    },
                  },
                },
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },

  // --- Bulk mute / unmute --------------------------------------------------
  "/communities/mute/bulk": {
    post: {
      tags: ["Communities"],
      operationId: "bulkMuteCommunities",
      summary: "Bulk mute or unmute communities",
      description:
        'Mute or unmute multiple communities at once. Set `action` to `"mute"` or `"unmute"`. For mute: communities already muted or where the caller is not an ACTIVE member are silently skipped; `durationMinutes` null/omitted → indefinite mute. For unmute: communities not currently muted are silently skipped.',
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkMuteRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Bulk mute/unmute result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/BulkMuteResult" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },

  "/communities/read/bulk": {
    post: {
      tags: ["Communities"],
      operationId: "bulkMarkCommunityChatsRead",
      summary: "Bulk mark community chats as read",
      description:
        "Zero the unread count for multiple communities at once. Updates `lastReadAt` on the caller's room-member rows in chat-service. Communities not joined or where chat is not enabled are silently skipped (updatedCount reflects only rows actually updated).",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkMarkReadRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Bulk mark-as-read result",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/BulkMarkReadResult" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": validationError,
        "401": unauthorized,
      },
    },
  },

  // --- Notification preferences --------------------------------------------
  "/communities/{id}/notification-preferences": {
    get: {
      tags: ["Communities"],
      operationId: "getCommunityNotificationPreferences",
      summary: "Get the caller's notification preferences",
      description:
        "ACTIVE-member only. Returns the caller's per-community notification toggles. When no preference row exists, defaults are returned (all toggles true; `createdAt`/`updatedAt` null).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Notification preferences",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityNotificationPreferenceData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Communities"],
      operationId: "setCommunityNotificationPreferences",
      summary: "Set or update the caller's notification preferences",
      description:
        "Upsert. ACTIVE-member only. At least one of `streamEnabled`, `chatEnabled`, `announcementEnabled` must be present; omitted fields are left unchanged.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/SetNotificationPrefsRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Notification preferences updated",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityNotificationPreferenceData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed (e.g. no preference field provided)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Not an ACTIVE member",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  // --- Permanent invitation link (PRIVATE communities) --------------------

  "/communities/{id}/invitation-link": {
    get: {
      tags: ["Communities"],
      operationId: "getCommunityInvitationLink",
      summary: "Get or generate the permanent invitation link",
      description:
        "Returns the community's **permanent** invitation code and shareable URL. " +
        "The code is generated on the **first call** and **never changes** — every subsequent " +
        "call returns the identical code regardless of how many times the endpoint is called.\n\n" +
        "**Stability guarantees:**\n" +
        "- Code does NOT change after community name / avatar / description updates\n" +
        "- Code does NOT change after community close / reopen\n" +
        "- Code does NOT change when members join or leave\n" +
        "- 100 concurrent calls return the same code\n\n" +
        "**Only available for PRIVATE communities.** PUBLIC communities use their handle-based " +
        "canonical URL (`https://aimess.me/<handle>`) — no code needed.\n\n" +
        "**Authorization:** any ACTIVE community member (MEMBER, MODERATOR, or ADMIN).\n\n" +
        "**Join flow for recipients:** share `invitationLink` with others. Recipients open " +
        "`GET /communities/invite-links/{invitationCode}` (preview) then " +
        "`POST /communities/invite-links/{invitationCode}/redeem` (join/request). " +
        "Default join mode is **request-to-join** (requires moderator approval).\n\n" +
        "**Future:** a separate `POST /communities/:id/regenerate-invitation` endpoint " +
        "(not yet implemented) will allow admins to intentionally rotate the code.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID (MongoDB ObjectId).",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description:
            "Permanent invitation link. The code is stable — cache this response indefinitely.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        required: [
                          "communityId",
                          "communityName",
                          "invitationCode",
                          "invitationLink",
                          "appDeepLink",
                          "createdAt",
                        ],
                        properties: {
                          communityId: {
                            type: "string",
                            description: "Community MongoDB ObjectId.",
                          },
                          communityName: {
                            type: "string",
                            description: "Display name of the community.",
                          },
                          invitationCode: {
                            type: "string",
                            description:
                              "22-character base64url code (128-bit entropy). Permanent — never changes unless explicitly regenerated by an admin.",
                            example: "abc123XYZ-UVWxyz789AB",
                          },
                          invitationLink: {
                            type: "string",
                            description:
                              "Shareable HTTPS link: `https://aimess.me/+<code>`. Pass this to recipients.",
                            example: "https://aimess.me/+abc123XYZ-UVWxyz789AB",
                          },
                          appDeepLink: {
                            type: "string",
                            description:
                              "Mobile deep-link: `aimess://join?code=<code>`.",
                            example: "aimess://join?code=abc123XYZ-UVWxyz789AB",
                          },
                          createdAt: {
                            type: "integer",
                            format: "int64",
                            description:
                              "Epoch milliseconds when the code was first generated.",
                            example: 1750000000000,
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Community is not PRIVATE — only PRIVATE communities have permanent invitation codes",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": {
          description: "Missing or invalid Bearer token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "403": {
          description:
            "Caller is not an ACTIVE member of this community (non-members, LEFT, BANNED, PENDING are rejected)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  // --- Invite links --------------------------------------------------------

  "/communities/invite-links/{code}": {
    get: {
      tags: ["Communities"],
      operationId: "previewCommunityInviteLink",
      summary: "Preview a community via its invite link",
      description:
        "Returns limited community information for display before the user decides to join. " +
        "Requires authentication. `isJoined` is true when the caller is already an ACTIVE member. " +
        "Banned callers receive 403.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "code",
          in: "path",
          required: true,
          description: "Alphanumeric invite code from the invite link URL.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{4,64}$" },
        },
      ],
      responses: {
        "200": {
          description: "Community preview",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/InviteLinkPreviewData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": {
          description: "Missing or invalid Bearer token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "403": {
          description: "Caller is banned from this community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Invite link not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "410": {
          description:
            "Invite link has been revoked, has expired, or has reached its usage limit",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  "/communities/{id}/invite-links": {
    post: {
      tags: ["Communities"],
      operationId: "createCommunityInviteLink",
      summary:
        "Get the permanent link (default) or create a custom temporary link",
      description:
        "**Authorization: any active community member** (MEMBER, MODERATOR, or ADMIN). " +
        "Required state: the caller must have an ACTIVE membership in this community. " +
        "Non-members, removed (LEFT), banned (BANNED), and pending (PENDING) members are rejected with 403.\n\n" +
        "**This endpoint has two modes, selected by the request body:**\n\n" +
        "1. **Default / bare call (empty body `{}`)** — the *single source of truth* path. " +
        "Returns the community's **PERMANENT** invitation link:\n" +
        "   - **PRIVATE**: the code is generated **once** on the first bare call and stored on the community " +
        "(`https://aimess.me/+<code>` + `aimess://join?code=<code>`, `linkType: PRIVATE_INVITE`). " +
        "**Every subsequent bare call returns the IDENTICAL code** — no new rows, no new code, no rate-limit/cap " +
        "consumption. The code never changes across rename / avatar / description / close-reopen / member changes. " +
        "`linkId` is the sentinel `permanent:<communityId>`. This is what a *Generate Invitation Link* button should call.\n" +
        "   - **PUBLIC**: a handle-based, deterministic link (`https://aimess.me/<handle>`, `linkType: PUBLIC_HANDLE`) — " +
        "already stable; the code never appears in the share URL.\n\n" +
        "2. **Parameterized call (any of `maxUses` / `expiresInMinutes` / `autoApprove` present)** — creates a NEW " +
        "**temporary** invite-link row (multi-use / expiring / auto-approve), the legacy behavior. " +
        "`maxUses` null/omitted → unlimited; `expiresInMinutes` null/omitted → never expires; " +
        "`autoApprove: false` (default) keeps moderator approval. Abuse-protected: per-user create rate limit (429) " +
        "and a per-member cap on simultaneously-active links (403). Use this for one-off or time-boxed invites.\n\n" +
        "The permanent link is ALSO available at the dedicated, richer `GET /communities/:id/invitation-link` " +
        "(returns `invitationCode` / `invitationLink` / `createdAt` epoch-ms). Both are backed by the same stored code.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateInviteLinkRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Invite link created",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityInviteLinkData",
                      },
                    },
                  },
                ],
              },
              examples: {
                publicCommunity: {
                  summary: "PUBLIC community — handle-based share URL",
                  description:
                    "`url`/`appDeepLink` are derived from the community handle and are deterministic; " +
                    "`linkType` is PUBLIC_HANDLE. The persisted `code` is retained for bulk-send/redeem " +
                    "parity but never appears in the primary share URL.",
                  value: {
                    success: true,
                    message: "Invite link created",
                    data: {
                      linkId: "6843e1a2b5c3d4e5f6a7b8c9",
                      code: "AbCdEf123",
                      url: "https://aimess.me/tech_community",
                      appDeepLink: "aimess://resolve?handle=tech_community",
                      linkType: "PUBLIC_HANDLE",
                      communityId: "6843d0f1a4b2c3d4e5f60718",
                      createdBy: "11111111-1111-4111-8111-111111111111",
                      maxUses: null,
                      usedCount: 0,
                      autoApprove: false,
                      expiresAt: null,
                      revokedAt: null,
                      createdAt: "2026-06-24T10:00:00.000Z",
                      isActive: true,
                    },
                  },
                },
                privateCommunity: {
                  summary: "PRIVATE community — invite-code share URL",
                  description:
                    "`url`/`appDeepLink` carry the non-guessable invite code; `linkType` is PRIVATE_INVITE. " +
                    "Expiry, `maxUses`, revocation and redeem all behave as before.",
                  value: {
                    success: true,
                    message: "Invite link created",
                    data: {
                      linkId: "6843e1a2b5c3d4e5f6a7b8ca",
                      code: "Zk9Qw2Lp7",
                      url: "https://aimess.me/+Zk9Qw2Lp7",
                      appDeepLink: "aimess://join?code=Zk9Qw2Lp7",
                      linkType: "PRIVATE_INVITE",
                      communityId: "6843d0f1a4b2c3d4e5f60719",
                      createdBy: "22222222-2222-4222-8222-222222222222",
                      maxUses: 100,
                      usedCount: 0,
                      autoApprove: false,
                      expiresAt: "2026-07-24T10:00:00.000Z",
                      revokedAt: null,
                      createdAt: "2026-06-24T10:00:00.000Z",
                      isActive: true,
                    },
                  },
                },
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not an ACTIVE member of this community (non-member, removed/LEFT, banned, or pending), the community is not writable (suspended/closed), or the per-member active-link cap is reached.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "429": {
          description: "Per-user invite-link create rate limit exceeded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
    get: {
      tags: ["Communities"],
      operationId: "listCommunityInviteLinks",
      summary: "List invite links for a community",
      description:
        "Any active member (MEMBER, MODERATOR, or ADMIN). Filter by status: active/expired/revoked.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "page",
          in: "query",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: ["active", "expired", "revoked"] },
        },
      ],
      responses: {
        "200": {
          description: "Invite links",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/InviteLinkListResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is not an active member of this community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/invite-links/{linkId}": {
    delete: {
      tags: ["Communities"],
      operationId: "revokeCommunityInviteLink",
      summary: "Revoke a community invite link",
      description: "MODERATOR/ADMIN only. Idempotent on already-revoked links.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
        {
          name: "linkId",
          in: "path",
          required: true,
          description:
            "Invite link ID from GET /communities/{id}/invite-links.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Invite link revoked",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/CommunityInviteLinkData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller lacks MODERATOR rank",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Community or invite link not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/communities/{id}/invite-links/bulk-send": {
    post: {
      tags: ["Communities"],
      operationId: "bulkShareCommunityInviteLink",
      summary: "Bulk-share an invite link via system DMs",
      description:
        "**Authorization: any active community member** (MEMBER, MODERATOR, or ADMIN). " +
        "Required state: the caller must have an ACTIVE membership in this community; non-members, removed (LEFT), banned (BANNED), and pending (PENDING) members are rejected with 403. " +
        "Resolves or auto-creates one active invite link **belonging to this community**, then fires a system DM to each unique recipient via chat-service (RabbitMQ fan-out). " +
        "A `linkId` from a DIFFERENT community is rejected with 404 (a Community A member can never send a Community B link); an inactive/expired/revoked link is rejected with 403. " +
        "The caller is automatically excluded from the recipient list. " +
        "Pass `linkId` to reuse a specific link; omit to auto-pick the first active link (or create one if none exists). " +
        "Recipients receive a `SYSTEM` / `COMMUNITY_INVITE` message in their private conversation with the inviter. " +
        "Abuse-protected: per-user bulk-send rate limit (429), max 50 recipients per request, and a recorded audit entry per call.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          description: "Community ID.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["userIds"],
              properties: {
                userIds: {
                  type: "array",
                  items: { type: "string", format: "uuid" },
                  minItems: 1,
                  maxItems: 50,
                  description:
                    "Recipients, identified by their canonical platform user UUID (AuthUser.id) — NOT a Mongo ObjectId. 1–50 per request; duplicates and the caller are removed. A non-UUID value is rejected with 400.",
                  example: ["885ad4e0-e238-4f9a-9773-e215321885b4"],
                },
                linkId: {
                  type: "string",
                  description:
                    "Optional. Reuse this specific invite link (a Mongo ObjectId, 24 hex chars). If omitted, the first active link is used (or a new one is created).",
                  example: "6a3b77c160056d00f5b8d6ee",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Partial-success (non-atomic). The link DM is enqueued for every ELIGIBLE recipient; ineligible recipients are reported per-user in `failures` and never hide the valid sends. A system DM is enqueued ONLY for the userIds in `sentUserIds`.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          link: {
                            allOf: [
                              {
                                $ref: "#/components/schemas/CommunityInviteLinkData",
                              },
                            ],
                            description:
                              "The invite link used for this bulk-send (may be auto-created if none existed).",
                          },
                          summary: {
                            type: "object",
                            description: "Per-request counts.",
                            properties: {
                              requested: {
                                type: "integer",
                                description:
                                  "Unique userIds received (after dedup, before self-skip).",
                              },
                              sent: {
                                type: "integer",
                                description:
                                  "Recipients the invite DM was successfully enqueued for.",
                              },
                              failed: {
                                type: "integer",
                                description:
                                  "Recipients rejected for a per-user reason (see failures array).",
                              },
                              skipped: {
                                type: "integer",
                                description:
                                  "Recipients excluded without counting as a failure (the caller themselves).",
                              },
                            },
                            required: [
                              "requested",
                              "sent",
                              "failed",
                              "skipped",
                            ],
                          },
                          sentUserIds: {
                            type: "array",
                            items: { type: "string", format: "uuid" },
                            description:
                              "Exact UUIDs the invite DM was enqueued for. " +
                              "Socket/push events are emitted ONLY for IDs in this list.",
                          },
                          failures: {
                            type: "array",
                            description:
                              "Per-user rejections. One entry per ineligible recipient. " +
                              "Ineligible recipients are always reported — they never silently drop valid sends.",
                            items: {
                              type: "object",
                              required: ["userId", "code", "message"],
                              properties: {
                                userId: {
                                  type: "string",
                                  format: "uuid",
                                  description:
                                    "The rejected recipient's AuthUser UUID.",
                                },
                                code: {
                                  type: "string",
                                  enum: [
                                    "USER_NOT_FOUND",
                                    "ALREADY_MEMBER",
                                    "USER_BANNED",
                                  ],
                                  description:
                                    "USER_NOT_FOUND = platform user does not exist; " +
                                    "ALREADY_MEMBER = already an ACTIVE member of this community; " +
                                    "USER_BANNED = banned from this community.",
                                },
                                message: {
                                  type: "string",
                                  description:
                                    "Human-readable reason (localised).",
                                },
                              },
                            },
                          },
                          queued: {
                            type: "integer",
                            description:
                              "Back-compat alias of `summary.sent` — number of DMs enqueued.",
                          },
                          skipped: {
                            type: "integer",
                            description:
                              "Back-compat alias of `summary.skipped` — caller excluded from recipient list.",
                          },
                        },
                        required: [
                          "link",
                          "summary",
                          "sentUserIds",
                          "failures",
                        ],
                      },
                    },
                  },
                ],
              },
              examples: {
                partialSuccess: {
                  summary:
                    "3 requested — 1 sent, 1 already-member, 1 caller-self-skipped",
                  description:
                    "The most common mixed-outcome response. `sentUserIds` contains only the " +
                    "recipients the DM was enqueued for; failures lists the rejected recipient " +
                    "with a precise code. The caller is automatically excluded (skipped=1).",
                  value: {
                    success: true,
                    message: "Invites sent",
                    data: {
                      link: {
                        linkId: "6843e1a2b5c3d4e5f6a7b8c9",
                        code: "Zk9Qw2Lp7",
                        url: "https://aimess.me/+Zk9Qw2Lp7",
                        appDeepLink: "aimess://join?code=Zk9Qw2Lp7",
                        linkType: "PRIVATE_INVITE",
                        communityId: "6843d0f1a4b2c3d4e5f60719",
                        createdBy: "99999999-9999-4999-8999-999999999999",
                        maxUses: null,
                        usedCount: 1,
                        autoApprove: false,
                        expiresAt: null,
                        revokedAt: null,
                        createdAt: "2026-06-24T10:00:00.000Z",
                        isActive: true,
                      },
                      summary: {
                        requested: 3,
                        sent: 1,
                        failed: 1,
                        skipped: 1,
                      },
                      sentUserIds: ["885ad4e0-e238-4f9a-9773-e215321885b4"],
                      failures: [
                        {
                          userId: "33333333-3333-4333-8333-333333333333",
                          code: "ALREADY_MEMBER",
                          message: "User is already a member of this community",
                        },
                      ],
                      queued: 1,
                      skipped: 1,
                    },
                  },
                },
                allSent: {
                  summary: "2 requested — 2 sent (all eligible)",
                  value: {
                    success: true,
                    message: "Invites sent",
                    data: {
                      link: {
                        linkId: "6843e1a2b5c3d4e5f6a7b8c9",
                        code: "Zk9Qw2Lp7",
                        url: "https://aimess.me/+Zk9Qw2Lp7",
                        appDeepLink: "aimess://join?code=Zk9Qw2Lp7",
                        linkType: "PRIVATE_INVITE",
                        communityId: "6843d0f1a4b2c3d4e5f60719",
                        createdBy: "99999999-9999-4999-8999-999999999999",
                        maxUses: null,
                        usedCount: 2,
                        autoApprove: false,
                        expiresAt: null,
                        revokedAt: null,
                        createdAt: "2026-06-24T10:00:00.000Z",
                        isActive: true,
                      },
                      summary: {
                        requested: 2,
                        sent: 2,
                        failed: 0,
                        skipped: 0,
                      },
                      sentUserIds: [
                        "885ad4e0-e238-4f9a-9773-e215321885b4",
                        "22222222-2222-4222-8222-222222222222",
                      ],
                      failures: [],
                      queued: 2,
                      skipped: 0,
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            'Validation error — `userIds` is empty, exceeds 50, or contains a value that is not a valid UUID ("One or more user IDs are invalid"); or `linkId` is not a valid ObjectId.',
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not an ACTIVE member of this community (non-member, removed/LEFT, banned, or pending), the community is not writable (suspended/closed), or the specified link is inactive/expired/revoked.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description:
            "Community not found, or the specified invite link does not exist OR belongs to a different community (cross-community link use).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "429": {
          description: "Per-user invite-link bulk-send rate limit exceeded",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },

  "/communities/invite-links/{code}/redeem": {
    post: {
      tags: ["Communities"],
      operationId: "redeemCommunityInviteLink",
      summary: "Redeem a community invite link",
      description:
        "Adds (or reactivates) the caller as an ACTIVE MEMBER and atomically increments the link's usedCount. Idempotent for already-ACTIVE members (usedCount NOT incremented). BANNED users cannot redeem.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "code",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Joined via invite link",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/RedeemInviteLinkResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller is BANNED from the target community",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "404": {
          description: "Invite link or community not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "410": {
          description:
            "Invite link revoked, expired, or exhausted (max uses reached)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
} as const;

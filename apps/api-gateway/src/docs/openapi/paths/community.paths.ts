const unauthorized = {
  description: "Missing or invalid access token",
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
      summary: "Create a community",
      description:
        "Creator becomes ADMIN (memberCount starts at 1). `handle` is the unique @-slug (lowercase). Optional `memberIds` (UUIDs) are added as ACTIVE members. Upload an avatar via /communities/uploads/url first, then pass the returned object key as `avatarObjectKey`.",
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
  },
  "/communities/categories": {
    get: {
      tags: ["Communities"],
      summary: "List community categories",
      description: "Active categories sorted by order then name.",
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
  },
  "/communities/name-available": {
    get: {
      tags: ["Communities"],
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
        "401": unauthorized,
      },
    },
  },
  "/communities/handle-available": {
    get: {
      tags: ["Communities"],
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
        "401": unauthorized,
      },
    },
  },
  "/communities/mine": {
    get: {
      tags: ["Communities"],
      summary: "List communities I belong to",
      description:
        "Communities where you are an ACTIVE member. Offset/page pagination (`page` + `limit`); response carries `pagination` (totalData, totalPage, currentPage, limit, hasMore) and `data`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
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
          description: "My communities",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/MyCommunitiesResponseData",
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
      summary: "Discover / search / browse public communities",
      description:
        "Public communities you are not already in (active, pending, and banned memberships are excluded). Optional `q` searches name and handle (case-insensitive); optional `categoryId` filters by category. `filter` defaults to `all`; `live` and `upcoming` are reserved for livestream-based discovery and currently return an empty page (no stream-service yet). Newest-first, offset/page pagination (`page` + `limit`); response carries `pagination` and `data`.",
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
  "/communities/uploads/url": {
    post: {
      tags: ["Communities"],
      summary: "Get presigned URL to upload a community file",
      description:
        "Generic upload endpoint. Pass `type` (e.g. `COMMUNITY_AVATAR`), `contentType`, and `contentLength` (bytes). Returns a short-lived PUT URL (private bucket). PUT the file to `uploadUrl` with the `Content-Type` header only, then pass the returned `objectKey` as `avatarObjectKey` when creating/updating the community.",
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/LanguageHeader" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/CommunityUploadUrlRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Presigned upload URL",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/UploadUrlResponseData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or file too large",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
      summary: "Get a community",
      description:
        "Returns the community with its category, member count, your role (`myRole`, null if not a member), and presigned avatar/cover URLs.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
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
      summary: "Update a community",
      description:
        "Admin only. Partial update; name/handle re-checked for uniqueness (excluding this community).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
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
  "/communities/{id}/join": {
    post: {
      tags: ["Communities"],
      summary: "Join a public community",
      description:
        "Self-join a PUBLIC community as a MEMBER. Idempotent: an already-ACTIVE member is returned unchanged (no write or audit). Previously-LEFT members are reactivated (joinedAt preserved, snapshot refreshed, role forced to MEMBER, audited `COMMUNITY_JOINED` with `{ reactivated: true }`). PRIVATE communities require an invite (use `POST /:id/members` from an admin/moderator). BANNED members cannot rejoin.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Joined (or already a member)",
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
        "403": {
          description:
            "Community is PRIVATE (invite required) or caller is BANNED from this community",
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
  "/communities/{id}/transfer-admin": {
    post: {
      tags: ["Communities"],
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
  "/communities/{id}/members/{userId}/role": {
    put: {
      tags: ["Communities"],
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
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
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
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
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
      summary: "Ban a member",
      description:
        "Admin only. Sets the member's status to BANNED and recomputes memberCount. You cannot ban yourself or the community admin. Idempotent when the member is already banned.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
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
      summary: "Unban a member",
      description:
        "Admin only. Lifts a ban: a BANNED member's status is set to LEFT (they are not auto-re-added — add them back or let them re-join) and memberCount is recomputed. Fails if the member is not currently banned.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "userId",
          in: "path",
          required: true,
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
  "/communities/join-requests/mine": {
    get: {
      tags: ["Communities"],
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
      summary: "Decline an invite",
      description: "Invitee only. Marks the invite DECLINED. No member write.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "inviteId",
          in: "path",
          required: true,
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
      summary: "Submit a join request",
      description:
        "PRIVATE communities only. If a PENDING invite already exists for the caller, this auto-accepts the invite (returns `AutoJoinedInviteData` with status 200) instead of creating a new request.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
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
                        $ref: "#/components/schemas/AutoJoinedInviteData",
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
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
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
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
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
  "/communities/{id}/join-requests/{requestId}": {
    delete: {
      tags: ["Communities"],
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
          schema: { type: "string" },
        },
        {
          name: "requestId",
          in: "path",
          required: true,
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
      summary: "Invite a user to a community",
      description:
        "Moderator or admin only. If a PENDING join-request already exists from the invitee, this auto-approves the request (returns `AutoApprovedJoinRequestData` with status 200) instead of creating a new invite.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateInviteRequest" },
          },
        },
      },
      responses: {
        "201": {
          description: "Invite created",
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
        "200": {
          description:
            "Mutual want detected — pending join-request auto-approved, invitee is now an ACTIVE member.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/AutoApprovedJoinRequestData",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Validation failed or caller cannot invite self",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
        "401": unauthorized,
        "403": {
          description:
            "Caller is not a moderator/admin, or the invitee is banned",
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
          description: "Invitee is already an ACTIVE member",
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
      summary: "Submit a community report",
      description:
        "Any ACTIVE member may file a report. Omit `targetUserId` to report the community itself; otherwise the targeted user must currently have a member row (any status). An existing OPEN report from the same reporter on the same (community, target) tuple is returned idempotently (still 201).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
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
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
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
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
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
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
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
  "/communities/{id}/reports/{reportId}": {
    delete: {
      tags: ["Communities"],
      summary: "Withdraw your own report",
      description:
        "Reporter-only. Allowed only while the report is OPEN. Terminal status WITHDRAWN with resolution `\"withdrawn_by_reporter\"`. Not audited (caller's intent didn't materialize).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "reportId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Report withdrawn",
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

  // --- Mute settings -------------------------------------------------------
  "/communities/{id}/mute": {
    get: {
      tags: ["Communities"],
      summary: "Get the caller's mute setting for a community",
      description:
        "ACTIVE-member only. Returns 404 (`COMMUNITY_NOT_MUTED`) when no mute row exists.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
      summary: "Set or update the caller's mute setting",
      description:
        "Upsert. ACTIVE-member only. `durationMinutes` null/omitted → mute indefinitely; positive integer → mute for N minutes.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
      summary: "Clear the caller's mute setting",
      description: "Idempotent. ACTIVE-member only.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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

  // --- Invite links --------------------------------------------------------
  "/communities/{id}/invite-links": {
    post: {
      tags: ["Communities"],
      summary: "Create a shareable invite link",
      description:
        "MODERATOR/ADMIN only. `maxUses` null/omitted → unlimited; `expiresInMinutes` null/omitted → never expires.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
            },
          },
        },
        "401": unauthorized,
        "403": {
          description: "Caller lacks MODERATOR rank in this community",
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
    get: {
      tags: ["Communities"],
      summary: "List invite links for a community",
      description:
        "MODERATOR/ADMIN only. Filter by status: active/expired/revoked.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
          description: "Caller lacks MODERATOR rank in this community",
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
      summary: "Revoke a community invite link",
      description: "MODERATOR/ADMIN only. Idempotent on already-revoked links.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "linkId",
          in: "path",
          required: true,
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
  "/communities/invite-links/{code}/redeem": {
    post: {
      tags: ["Communities"],
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

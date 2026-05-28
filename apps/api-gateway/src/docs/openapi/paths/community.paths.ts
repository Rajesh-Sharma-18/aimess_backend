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
        "Communities where you are an ACTIVE member. Cursor pagination on community id; returns `nextCursor` (null when no more).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/LanguageHeader" },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Community id cursor from a previous `nextCursor`.",
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
  },
  "/communities/{id}/members": {
    get: {
      tags: ["Communities"],
      summary: "List community members",
      description:
        "Any ACTIVE member (any role) may view the roster. Cursor pagination on member id; returns `nextCursor` (null when no more). Optional `status` filter defaults to ACTIVE.",
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
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Member id cursor from a previous `nextCursor`.",
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
        "Moderator or admin only. Returns the moderation audit trail (promote/demote, kick, ban, unban, admin transfer), newest first. Cursor pagination on audit-log id; returns `nextCursor` (null when no more).",
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
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Audit-log id cursor from a previous `nextCursor`.",
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
        "Leave a community you are an ACTIVE member of (status set to LEFT) and recompute memberCount. If the admin leaves, ownership is auto-handed to the longest-tenured active moderator; if there is no moderator to hand over to, the admin cannot leave.",
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
        "400": {
          description:
            "The community admin cannot leave because there is no active moderator to hand over to",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
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
} as const;

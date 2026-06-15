const unauthorized = {
  description: "Missing or invalid access token",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const badRequest = {
  description: "Validation failed",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const mediaUploadUrl = {
  post: {
    tags: ["Media"],
    summary: "Generate presigned upload URL",
    description:
      "Returns a short-lived presigned PUT URL for direct-to-storage upload. The client PUTs the file directly to the returned uploadUrl using the provided uploadHeaders.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["category", "contentType", "contentLength"],
            properties: {
              category: {
                type: "string" as const,
                enum: [
                  "USER_AVATAR",
                  "COMMUNITY_AVATAR",
                  "COMMUNITY_COVER",
                  "CHAT_ATTACHMENT",
                  "COMMUNITY_CHAT_ATTACHMENT",
                  "GROUP_AVATAR",
                  "GROUP_CHAT_ATTACHMENT",
                ],
                description:
                  "Media category determines bucket, key prefix, and size/type limits.",
              },
              contentType: { type: "string" as const, example: "image/jpeg" },
              contentLength: {
                type: "integer" as const,
                example: 204800,
                description: "File size in bytes.",
              },
              ownerId: {
                type: "string" as const,
                format: "uuid",
                description:
                  "Community id for COMMUNITY_AVATAR/COVER; defaults to caller userId for other categories.",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Upload URL generated",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/MediaUploadUrlResponse" },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "415": {
        description: "Unsupported media type",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "500": {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

const mediaDownloadUrl = {
  post: {
    tags: ["Media"],
    summary: "Generate presigned download URL",
    description:
      "Returns a short-lived presigned GET URL for downloading/viewing a stored media object.",
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["objectKey", "category"],
            properties: {
              objectKey: {
                type: "string" as const,
                example: "chat-uploads/user123/file-abc.jpg",
              },
              category: {
                type: "string" as const,
                enum: [
                  "USER_AVATAR",
                  "COMMUNITY_AVATAR",
                  "COMMUNITY_COVER",
                  "CHAT_ATTACHMENT",
                  "COMMUNITY_CHAT_ATTACHMENT",
                  "GROUP_AVATAR",
                  "GROUP_CHAT_ATTACHMENT",
                ],
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Download URL generated",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/MediaDownloadUrlResponse" },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": {
        description:
          "Forbidden — you do not own this object key (CHAT_ATTACHMENT category)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
      "500": {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
          },
        },
      },
    },
  },
};

export const mediaPaths = {
  "/media/upload-url": mediaUploadUrl,
  "/media/download-url": mediaDownloadUrl,
};

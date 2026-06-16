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

const forbidden = {
  description: "Forbidden",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

const internalError = {
  description: "Internal server error",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiErrorResponse" },
    },
  },
};

/**
 * Supported content-types for chat attachment categories.
 * Updated with ZIP support (Phase 2).
 */
const CHAT_CONTENT_TYPES = [
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  // Video
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/x-m4v",
  // Audio
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
] as const;

const UPLOAD_CATEGORIES = [
  "USER_AVATAR",
  "COMMUNITY_AVATAR",
  "COMMUNITY_COVER",
  "CHAT_ATTACHMENT",
  "COMMUNITY_CHAT_ATTACHMENT",
  "GROUP_AVATAR",
  "GROUP_CHAT_ATTACHMENT",
] as const;

const mediaUploadUrl = {
  post: {
    tags: ["Media"],
    summary: "Generate presigned upload URL",
    description: `Returns a short-lived presigned PUT URL for direct-to-storage upload.

**Upload flow:**
1. Call this endpoint to get \`uploadUrl\` + \`objectKey\`.
2. PUT the file directly to \`uploadUrl\` with the \`Content-Type\` header set to the declared \`contentType\`.
3. Call **POST /media/confirm** with the same \`objectKey\` + \`contentType\`. The file undergoes magic-byte validation, ZIP inspection (for archives), and antivirus scanning.
4. Only files that pass confirm (\`scanStatus: "CLEAN"\`) can be downloaded.

**Allowed \`contentType\` by category:**
- **Avatars & covers** (\`USER_AVATAR\`, \`COMMUNITY_AVATAR\`, \`COMMUNITY_COVER\`, \`GROUP_AVATAR\`) — images only: \`image/jpeg\`, \`image/png\`, \`image/webp\`. Max 5 MB.
- **Chat attachments** (\`CHAT_ATTACHMENT\`, \`GROUP_CHAT_ATTACHMENT\`, \`COMMUNITY_CHAT_ATTACHMENT\`) — the full media set below.

**Chat attachment types & per-MIME size caps:**
- **Images** — \`image/jpeg\`, \`image/png\`, \`image/webp\` (25 MB), \`image/gif\` (30 MB)
- **Video** — \`video/mp4\`, \`video/quicktime\` (mov), \`video/x-matroska\` (mkv), \`video/webm\`, \`video/x-msvideo\` (avi), \`video/x-m4v\` (≤100 MB ceiling)
- **Audio / voice** — \`audio/mpeg\` (mp3), \`audio/ogg\`, \`audio/wav\`, \`audio/mp4\` / \`audio/x-m4a\` (m4a), \`audio/aac\`, \`audio/flac\`
- **Documents** — \`application/pdf\` (50 MB); Word \`application/msword\` / \`…wordprocessingml.document\` (50 MB); Excel \`application/vnd.ms-excel\` / \`…spreadsheetml.sheet\` (50 MB); PowerPoint \`application/vnd.ms-powerpoint\` / \`…presentationml.presentation\` (100 MB); \`text/plain\`, \`application/json\`, \`application/xml\`, \`text/xml\` (10 MB); \`text/csv\` (25 MB)
- **Archives** — \`application/zip\`, \`application/x-zip-compressed\` (100 MB)`,
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
                enum: UPLOAD_CATEGORIES,
                description:
                  "Media category — determines bucket, key prefix, and size/type limits.",
              },
              contentType: {
                type: "string" as const,
                enum: CHAT_CONTENT_TYPES,
                example:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                description:
                  "Declared MIME type. Allowed values DEPEND on category (avatars/covers accept only image/jpeg|png|webp; chat categories accept the full set) — see the table in the endpoint description. Must match the file's actual bytes (verified by /confirm).",
              },
              contentLength: {
                type: "integer" as const,
                example: 204800,
                description:
                  "File size in bytes. Must not exceed the per-MIME cap.",
              },
              ownerId: {
                type: "string" as const,
                format: "uuid",
                description:
                  "Community/group id for COMMUNITY_AVATAR/COVER categories; defaults to caller userId for all others.",
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
        description: "Unsupported or mismatched content type",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            example: {
              success: false,
              message: "Unsupported file content type",
            },
          },
        },
      },
      "500": internalError,
    },
  },
};

const mediaConfirm = {
  post: {
    tags: ["Media"],
    summary: "Confirm upload + run security scan",
    description: `Called after the client has successfully PUT the file to the presigned MinIO URL. Validates the file immediately so errors surface during the upload flow — not at download time.

**Structural checks (synchronous — run on this request):**
1. Verifies the object exists in storage.
2. Downloads the first 512 bytes and validates file-signature (magic bytes) against the declared MIME type.
3. For ZIP / OOXML files: inspects the archive structure for ZIP bombs, nested archives, and correct OOXML content-type.
4. Violations are **terminal**: the file is deleted from storage and confirm returns **HTTP 200** with a terminal \`scanStatus\` (it does NOT throw) — read the verdict below.

**Antivirus scan (asynchronous — when \`CLAMAV_ENABLED=true\`):**
The AV scan is enqueued as a Bull job and this endpoint returns \`scanStatus: "PENDING"\` immediately. The in-process worker scans, writes \`CLEAN\`/\`QUARANTINED\` to Redis, and deletes the file if a virus is found. Poll \`GET /media/scan-status\` until \`CLEAN\` before requesting a download URL. In dev (\`CLAMAV_ENABLED=false\`) confirm returns \`CLEAN\` synchronously.

**This endpoint always responds HTTP 200 with a \`scanStatus\` verdict (the only non-200s are 400/401/403). Read \`data.scanStatus\`:**
- \`CLEAN\` — all checks passed; file is downloadable.
- \`PENDING\` — structural checks passed; AV scan in progress (poll /media/scan-status).
- \`SKIPPED\` — scanner disabled (dev mode); file accessible but unscanned.
- \`INFECTED\` — structural reject (magic-byte mismatch, ZIP bomb, nested archive, OOXML type mismatch). File deleted; not downloadable.
- \`QUARANTINED\` — virus detected by the AV scanner. File deleted; not downloadable.
- \`ERROR\` — scanner error; retry /confirm.

\`403\` (\`MEDIA_CONFIRM_FORBIDDEN\`) is returned only when the caller does not own the object.`,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            required: ["objectKey", "category", "contentType"],
            properties: {
              objectKey: {
                type: "string" as const,
                example: "chat-uploads/user-uuid/file-uuid.docx",
                description: "The objectKey returned by /upload-url.",
              },
              category: {
                type: "string" as const,
                enum: UPLOAD_CATEGORIES,
              },
              contentType: {
                type: "string" as const,
                example:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                description: "Must match the MIME declared at upload-url time.",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description:
          "Structural checks passed. File is either CLEAN (downloadable), PENDING (AV scan in progress), SKIPPED (dev mode), or ERROR (retry).",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    objectKey: {
                      type: "string" as const,
                      example: "chat-uploads/user-uuid/file-uuid.docx",
                    },
                    scanStatus: {
                      type: "string" as const,
                      enum: [
                        "CLEAN",
                        "PENDING",
                        "SKIPPED",
                        "ERROR",
                        "INFECTED",
                        "QUARANTINED",
                      ],
                      example: "CLEAN",
                      description:
                        "Terminal verdict in a uniform HTTP 200 body. CLEAN/SKIPPED = downloadable. PENDING = AV scan in progress (poll /media/scan-status). INFECTED = structural reject (magic-byte/ZIP/OOXML), file deleted. QUARANTINED = virus found, file deleted. ERROR = scanner down; retry /confirm.",
                    },
                    fileSize: {
                      type: "integer" as const,
                      example: 204800,
                      description: "Actual file size in bytes from storage.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": {
        description:
          "Caller does not own the object (MEDIA_CONFIRM_FORBIDDEN).",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            example: {
              success: false,
              error: { code: "MEDIA_CONFIRM_FORBIDDEN", message: "Forbidden" },
            },
          },
        },
      },
      "500": internalError,
    },
  },
};

const mediaDownloadUrl = {
  post: {
    tags: ["Media"],
    summary: "Generate presigned download URL",
    description: `Returns a short-lived presigned GET URL for downloading a stored media object.

**Auto-confirm on first call:**
If the file has never been confirmed, this endpoint automatically runs the security pipeline (magic-byte validation, ZIP inspection, optional AV scan) before issuing the download URL. No separate /confirm call needed — the frontend just uploads and downloads.

**Blocked when:**
- Scan status is \`PENDING\` (async AV scan in progress; poll /media/scan-status and retry) → 403 MEDIA_SCAN_PENDING
- Scan status is \`QUARANTINED\` or \`INFECTED\` (file rejected; deleted from storage) → 403 MEDIA_QUARANTINED
- Scan status is \`ERROR\` or any value outside the allow-list (\`CLEAN\`/\`SKIPPED\`) → 403 MEDIA_SCAN_PENDING (defense-in-depth allow-list gate)

**Safe-serving headers applied to the response:**
- \`X-Content-Type-Options: nosniff\`
- Documents / archives are served with \`Content-Disposition: attachment\` baked into the presigned URL, preventing inline browser rendering.`,
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
                example: "chat-uploads/user123/file-abc.docx",
              },
              category: {
                type: "string" as const,
                enum: UPLOAD_CATEGORIES,
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
          "Forbidden — ownership check failed, file quarantined, or scan pending",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            examples: {
              quarantined: {
                summary: "Virus detected",
                value: {
                  success: false,
                  message: "This file was blocked by a security scan",
                },
              },
              scanPending: {
                summary: "Confirm not yet called",
                value: {
                  success: false,
                  message:
                    "This file is still being scanned, please try again shortly",
                },
              },
              ownershipFailed: {
                summary: "Object key not owned by caller",
                value: {
                  success: false,
                  message: "You are not allowed to access this media",
                },
              },
            },
          },
        },
      },
      "500": internalError,
    },
  },
};

const mediaScanStatus = {
  get: {
    tags: ["Media"],
    summary: "Poll async media scan status",
    description:
      "Returns the current AV scan status for an uploaded object. Poll until CLEAN. PENDING = scan still running or no status yet; QUARANTINED/INFECTED = rejected and deleted.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "objectKey",
        in: "query" as const,
        required: true,
        schema: { type: "string" as const, maxLength: 500 },
        description: "The objectKey returned by /upload-url.",
      },
      {
        name: "category",
        in: "query" as const,
        required: true,
        schema: { type: "string" as const, enum: UPLOAD_CATEGORIES },
      },
    ],
    responses: {
      "200": {
        description: "Current scan status",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                data: {
                  type: "object" as const,
                  properties: {
                    objectKey: {
                      type: "string" as const,
                      example: "chat-uploads/user-uuid/file-uuid.docx",
                    },
                    scanStatus: {
                      type: "string" as const,
                      enum: [
                        "CLEAN",
                        "PENDING",
                        "QUARANTINED",
                        "INFECTED",
                        "SKIPPED",
                        "ERROR",
                      ],
                      example: "PENDING",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": forbidden,
      "500": internalError,
    },
  },
};

const mediaCancelUpload = {
  delete: {
    tags: ["Media"],
    summary: "Cancel an upload (delete the object)",
    description:
      "Deletes an uploaded object from storage — used to cancel an in-progress upload or discard an object the client decided not to reference. Ownership is enforced (the objectKey must be owned by the caller). Idempotent: deleting an already-absent object still returns 200.\n\n" +
      "`:objectKey` must be URL-encoded (it contains slashes), and `category` is passed as a query parameter.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "objectKey",
        in: "path" as const,
        required: true,
        schema: { type: "string" as const, maxLength: 500 },
        description:
          "URL-encoded object key returned by /upload-url, e.g. chat-uploads%2Fuser-uuid%2Ffile-uuid.pdf",
      },
      {
        name: "category",
        in: "query" as const,
        required: true,
        schema: { type: "string" as const, enum: UPLOAD_CATEGORIES },
      },
    ],
    responses: {
      "200": {
        description: "Object deleted (or already absent).",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                message: {
                  type: "string" as const,
                  example: "Upload cancelled",
                },
                data: {
                  type: "object" as const,
                  nullable: true,
                  example: null,
                },
              },
            },
          },
        },
      },
      "400": badRequest,
      "401": unauthorized,
      "403": {
        description: "Caller does not own the object (MEDIA_CANCEL_FORBIDDEN).",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            example: {
              success: false,
              error: { code: "MEDIA_CANCEL_FORBIDDEN", message: "Forbidden" },
            },
          },
        },
      },
      "500": internalError,
    },
  },
};

export const mediaPaths = {
  "/media/upload-url": mediaUploadUrl,
  "/media/confirm": mediaConfirm,
  "/media/download-url": mediaDownloadUrl,
  "/media/scan-status": mediaScanStatus,
  "/media/uploads/{objectKey}": mediaCancelUpload,
};

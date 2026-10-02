/** Paths relative to server URL `…/api/v1`. */
export const appVersionPaths = {
  "/app-version/check": {
    post: {
      tags: ["App"],
      operationId: "checkAppVersion",
      summary: "Check client app version",
      description:
        "Resolves the admin update policy for this client. `action` is the verdict: FORCE (admin rule — block), UNSUPPORTED_DEVICE (OS below the minimum), or STORE (no admin rule — the client asks its store using `store`). Legacy fields (`forceUpdate`, `optionalUpdate`, `isUpToDate`) are kept for shipped clients. Call on launch and on resume. Separately, when the admin enables `enforceOnServer`, every other /api/v1 call from a FORCE client (sending `x-platform` + `x-app-version`) returns 426 APP_UPDATE_REQUIRED, and the socket handshake is refused with the same message.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppVersionCheckRequest" },
            example: { platform: "android", version: "2.0.1", osLevel: 34 },
          },
        },
      },
      responses: {
        "200": {
          description: "Update verdict for the client",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ApiSuccessResponse" },
                  {
                    type: "object",
                    properties: {
                      data: {
                        $ref: "#/components/schemas/AppVersionCheckResponseData",
                      },
                    },
                  },
                ],
              },
              examples: {
                force: {
                  summary: "Admin rule forces this version",
                  value: {
                    success: true,
                    message: "App version checked",
                    data: {
                      platform: "android",
                      clientVersion: "1.9.0",
                      minimumRequiredVersion: "2.0.0",
                      latestRecommendedVersion: "2.1.0",
                      forceUpdate: true,
                      optionalUpdate: false,
                      isUpToDate: false,
                      storeUrl: "market://details?id=com.aifivetech.aimess",
                      mode: "ADMIN_MANAGED",
                      action: "FORCE",
                      reason: "BELOW_FORCE_VERSION",
                      latestVersion: "2.1.0",
                      fullyRolledOut: true,
                      enforceOnServer: false,
                      store: {
                        forceFromPriority: 4,
                        softFromPriority: 2,
                        escalateSoftAfterDays: 14,
                      },
                      title: "Update Available",
                      message: "Please update to keep using AIMESS.",
                      policyVersion: 7,
                      issuedAt: 1767139200000,
                    },
                  },
                },
                store: {
                  summary: "No admin rule — the store decides",
                  value: {
                    success: true,
                    message: "App version checked",
                    data: {
                      platform: "ios",
                      clientVersion: "2.0.1",
                      minimumRequiredVersion: "0.0.0",
                      latestRecommendedVersion: "2.1.0",
                      forceUpdate: false,
                      optionalUpdate: true,
                      isUpToDate: false,
                      mode: "STORE_MANAGED",
                      action: "STORE",
                      reason: "NONE",
                      latestVersion: "2.1.0",
                      fullyRolledOut: true,
                      enforceOnServer: false,
                      store: {
                        appStoreId: "123456789",
                        forceOnBump: "MAJOR",
                        softOnBump: "MINOR",
                      },
                      title: null,
                      message: null,
                      policyVersion: 7,
                      issuedAt: 1767139200000,
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation error — missing or invalid platform/version",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
              example: {
                success: false,
                message: "Validation error",
                errors: { platform: "platform must be one of: ANDROID, IOS" },
              },
            },
          },
        },
      },
    },
  },
};

/** Paths relative to server URL `…/api/v1`. */
export const appVersionPaths = {
  "/app-version/check": {
    post: {
      tags: ["App"],
      operationId: "checkAppVersion",
      summary: "Check client app version",
      description:
        "Returns whether the mobile app should show no update prompt, an optional update screen, or a mandatory (force) update screen. Call on every app launch before rendering the home view.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppVersionCheckRequest" },
            example: {
              platform: "ANDROID",
              version: "2.4.1",
              buildNumber: 241,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Update action for the client UI",
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
                upToDate: {
                  summary: "App is current — no update prompt needed",
                  value: {
                    success: true,
                    message: "Version check completed",
                    data: {
                      action: "NONE",
                      currentVersion: "2.4.1",
                      latestVersion: "2.4.1",
                      storeUrl: null,
                      releaseNotes: null,
                    },
                  },
                },
                optionalUpdate: {
                  summary: "New version available — optional update prompt",
                  value: {
                    success: true,
                    message: "Version check completed",
                    data: {
                      action: "OPTIONAL_UPDATE",
                      currentVersion: "2.4.1",
                      latestVersion: "2.5.0",
                      storeUrl:
                        "https://play.google.com/store/apps/details?id=tech.aimess",
                      releaseNotes: "New community features and bug fixes.",
                    },
                  },
                },
                forceUpdate: {
                  summary: "Version too old — force update screen",
                  value: {
                    success: true,
                    message: "Version check completed",
                    data: {
                      action: "FORCE_UPDATE",
                      currentVersion: "1.9.0",
                      latestVersion: "2.5.0",
                      storeUrl:
                        "https://play.google.com/store/apps/details?id=tech.aimess",
                      releaseNotes: "Critical security patch required.",
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

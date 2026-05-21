/** Paths relative to server URL `…/api/v1`. */
export const appVersionPaths = {
  "/app-version/check": {
    post: {
      tags: ["App"],
      summary: "Check client app version",
      description:
        "Returns whether the mobile app should show no update, an optional update, or a mandatory (force) update screen.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AppVersionCheckRequest" },
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
            },
          },
        },
        "400": {
          description: "Validation error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiErrorResponse" },
            },
          },
        },
      },
    },
  },
};

/**
 * Docs contract for friend requests × Super Admin platform ban.
 *
 * Pins the REST (OpenAPI) and realtime (AsyncAPI) docs to the names the
 * implementation actually uses, so a rename on either side fails here:
 *   - error key  USER_NO_LONGER_AVAILABLE  (@aimess/constants user.messages)
 *   - event      friend:request:invalidated (@aimess/shared-types FriendSocketEvents)
 *   - event      friend:relationship:sync   (sent to friends on unban)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { USER_MESSAGES } from "@aimess/constants";
import { FriendSocketEvents } from "@aimess/shared-types";

import {
  v1Components,
  v1Paths,
} from "../../src/docs/openapi/versions/v1/index.js";

type Op = {
  description: string;
  responses: Record<
    string,
    {
      content?: Record<
        string,
        { example?: unknown; examples?: Record<string, { value: unknown }> }
      >;
    }
  >;
};
const paths = v1Paths as unknown as Record<string, Record<string, Op>>;

/** Every example `value` (or single `example`) under one response code. */
function examples(op: Op, code: string): Array<Record<string, unknown>> {
  const media = op.responses[code]?.content?.["application/json"];
  if (!media) return [];
  const many = Object.values(media.examples ?? {}).map((e) => e.value);
  return [...many, ...(media.example ? [media.example] : [])] as Array<
    Record<string, unknown>
  >;
}

const errorCodes = (op: Op, code: string) =>
  examples(op, code).map((e) => e.code);

describe("OpenAPI — friend requests with a platform-banned peer", () => {
  it("documents a key that exists in the message catalogue", () => {
    expect(USER_MESSAGES).toHaveProperty("USER_NO_LONGER_AVAILABLE");
  });

  it("send: 404 USER_NO_LONGER_AVAILABLE for a banned addressee, 403 ACCOUNT_BANNED for a banned caller", () => {
    const op = paths["/users/friends/requests"].post;
    expect(errorCodes(op, "404")).toContain("USER_NO_LONGER_AVAILABLE");
    expect(errorCodes(op, "403")).toContain("ACCOUNT_BANNED");
  });

  it("accept: 404 USER_NO_LONGER_AVAILABLE alongside FRIEND_REQUEST_NOT_FOUND", () => {
    const op = paths["/users/friends/requests/{id}/accept"].post;
    expect(errorCodes(op, "404")).toEqual(
      expect.arrayContaining([
        "FRIEND_REQUEST_NOT_FOUND",
        "USER_NO_LONGER_AVAILABLE",
      ])
    );
  });

  it("reject: documents the idempotent 200 stale no-op and keeps the 404", () => {
    const op = paths["/users/friends/requests/{id}/reject"].post;
    expect(op.description).toMatch(/idempotent 200/i);
    const stale = examples(op, "200").find(
      (e) => (e.data as { status?: string }).status === "NONE"
    );
    expect(stale).toBeDefined();
    expect(errorCodes(op, "404")).toContain("FRIEND_REQUEST_NOT_FOUND");
  });

  it("cancel/delete: documents the same idempotent no-op", () => {
    expect(paths["/users/friends/requests/{id}"].delete.description).toMatch(
      /idempotent 200/i
    );
  });

  it("friendsCount says it excludes platform-banned friends", () => {
    const schemas = v1Components.schemas as Record<
      string,
      { properties: Record<string, { description?: string }> }
    >;
    const described = Object.values(schemas)
      .map((s) => s.properties?.friendsCount?.description ?? "")
      .filter(Boolean);
    expect(described.some((d) => /platform-banned/.test(d))).toBe(true);
  });
});

describe("AsyncAPI — realtime events", () => {
  const yaml = readFileSync(
    resolve(__dirname, "../../asyncapi/asyncapi.yaml"),
    "utf8"
  );

  it.each([
    [FriendSocketEvents.REQUEST_INVALIDATED, "FriendRequestInvalidated"],
    [FriendSocketEvents.RELATIONSHIP_SYNC, "FriendRelationshipSync"],
  ])(
    "documents %s as message %s with a receive operation",
    (event, message) => {
      expect(yaml).toContain(`name: "${event}"`);
      expect(yaml).toContain(`$ref: "#/components/messages/${message}"`);
      expect(yaml).toContain(`chat.on${message}:`);
      expect(yaml).toContain(`    ${message}Payload:`);
    }
  );

  it("the invalidated payload matches FriendRequestInvalidatedPayload", () => {
    const block = yaml.slice(
      yaml.indexOf("    FriendRequestInvalidatedPayload:"),
      yaml.indexOf("    FriendUnblockedPayload:")
    );
    expect(block).toContain("required: [peerId, friendshipId, reason]");
    expect(block).toContain("enum: [unavailable]");
  });
});

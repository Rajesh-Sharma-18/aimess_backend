/**
 * Ponytail self-check: serializer prefers fresh avatar-refresh maps over the
 * stale snapshot baked into payload.data at publish time.
 * Run with: `tsx apps/chat-service/src/lib/notification-serializer.check.ts`
 */
import assert from "node:assert/strict";

import {
  serializeNotification,
  type AvatarRefreshMaps,
} from "./notification-serializer.js";

const baseRow = {
  id: "n1",
  userId: "u1",
  actorId: "actor1",
  type: "friend.requested",
  entity: {},
  actorSnapshot: {},
  payload: {
    title: "New friend request",
    body: "X sent you a friend request.",
    data: {
      requesterId: "actor1",
      // stale/never-set — friend events carry no avatar today
    },
  },
  isRead: false,
  readAt: null,
  isDeleted: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Parameters<typeof serializeNotification>[0];

async function run() {
  // No refresh data available → no avatar, but actor id/displayName still present.
  const noRefresh = await serializeNotification(baseRow, "viewer1");
  assert.equal(noRefresh.actor?.avatar, null);
  assert.equal(noRefresh.actor?.id, "actor1");

  // Fresh refresh map resolves the avatar chat-service previously had no data for.
  const refresh: AvatarRefreshMaps = {
    actorById: new Map([
      [
        "actor1",
        { displayName: "Real Name", avatarUrl: "https://fresh/actor1.jpg" },
      ],
    ]),
    communityById: new Map(),
  };
  const withRefresh = await serializeNotification(baseRow, "viewer1", refresh);
  assert.equal(withRefresh.actor?.avatar?.url, "https://fresh/actor1.jpg");
  assert.equal(withRefresh.actor?.displayName, "Real Name");

  // Community row: fresh map wins over a stale stored communityAvatarUrl.
  const communityRow = {
    ...baseRow,
    type: "community.member_banned",
    payload: {
      title: "Banned",
      body: "You were banned.",
      data: {
        communityId: "c1",
        communityName: "Old Name",
        communityAvatarUrl: "https://stale-expired/c1.jpg",
      },
    },
  } as unknown as Parameters<typeof serializeNotification>[0];
  const communityRefresh: AvatarRefreshMaps = {
    actorById: new Map(),
    communityById: new Map([
      ["c1", { name: "New Name", avatarUrl: "https://fresh/c1.jpg" }],
    ]),
  };
  const communityDto = await serializeNotification(
    communityRow,
    "viewer1",
    communityRefresh
  );
  assert.equal(communityDto.community?.avatar?.url, "https://fresh/c1.jpg");
  assert.equal(communityDto.community?.name, "New Name");

  // Legacy login alert: an older build wrote the status OVER the description.
  // The description is rebuilt from data so the status is not rendered twice
  // (once as the body, once as the resolved line from actionTaken).
  const clobberedLogin = {
    ...baseRow,
    type: "auth.security_new_login",
    payload: {
      title: "Login Detected",
      body: "This was you.",
      data: {
        sessionId: "s1",
        browser: "Chrome",
        location: "San Francisco",
        actionTaken: "TRUSTED",
      },
    },
  } as unknown as Parameters<typeof serializeNotification>[0];
  const repaired = await serializeNotification(clobberedLogin, "viewer1");
  assert.equal(
    repaired.body,
    "New login detected on a chrome from San Francisco. If this wasn't you, Terminate Session"
  );
  assert.equal(repaired.actionTaken, "TRUSTED");

  // An untouched login body is returned verbatim — no rewriting of good rows.
  const healthyLogin = {
    ...clobberedLogin,
    payload: {
      title: "Login Detected",
      body: "New login detected on a firefox. If this wasn't you, Terminate Session",
      data: { sessionId: "s1", browser: "Firefox" },
    },
  } as unknown as Parameters<typeof serializeNotification>[0];
  assert.equal(
    (await serializeNotification(healthyLogin, "viewer1")).body,
    "New login detected on a firefox. If this wasn't you, Terminate Session"
  );

  // eslint-disable-next-line no-console
  console.log("notification-serializer.check ok");
}

run();

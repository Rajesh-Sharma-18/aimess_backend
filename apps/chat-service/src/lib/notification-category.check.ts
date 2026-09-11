/**
 * Ponytail self-check: prefix routing + Prisma where fragments for the fixed
 * catalogue, plus the legacy tab names shipped clients still send.
 * Run with: `tsx apps/chat-service/src/lib/notification-category.check.ts`
 */
import assert from "node:assert/strict";

import {
  canonicalCategoryId,
  categorize,
  categorizeId,
  categoryWhere,
  NOTIFICATION_CATEGORY_IDS,
  NOTIFICATION_CATEGORY_SEED,
  parseCategory,
  parsePlatform,
  rowCategory,
} from "./notification-category.js";

assert.equal(categorize("friend.requested"), "FRIENDS");
assert.equal(categorize("friend.accepted"), "FRIENDS");
// Call history has its own tab — it must NOT fall into FRIENDS.
assert.equal(categorize("call.activity"), "CALLS");
assert.equal(categorize("CALL_MISSED"), "CALLS");
assert.equal(categorize("community.member_added"), "COMMUNITIES");
assert.equal(categorize("community.livestream_started"), "COMMUNITIES");
assert.equal(categorize("chat.mention"), "MENTIONS");
assert.equal(categorize("community.mention"), "MENTIONS");
assert.equal(categorize("auth.security_new_login"), "SYSTEM");
assert.equal(categorize("session.created"), "SYSTEM");
assert.equal(categorize("user.registered"), "SYSTEM");
assert.equal(categorize("something.brand_new"), "SYSTEM");

// Explicit announcement category on the wire. The TAB it lists/counts under
// is still SYSTEM (categoryWhere is keyed on `type`), which is what keeps the
// per-tab counts and the Announcement glyph from contradicting each other.
assert.equal(categorize("ANNOUNCEMENT"), "SYSTEM");
assert.equal(rowCategory("ANNOUNCEMENT"), "Announcement");
assert.equal(rowCategory("MAINTENANCE"), "SYSTEM");
assert.equal(rowCategory("UPDATE_REQUIRED"), "SYSTEM");
assert.equal(rowCategory("friend.requested"), "FRIENDS");
assert.equal(rowCategory("call.activity"), "CALLS");
// "Announcement" is a RESPONSE value only — it must never become a filter.
assert.equal(parseCategory("Announcement"), "ALL");

assert.equal(parseCategory(undefined), "ALL");
assert.equal(parseCategory("friends"), "FRIENDS");
assert.equal(parseCategory("FRIENDS"), "FRIENDS");
assert.equal(parseCategory("bogus"), "ALL");
assert.equal(parseCategory(42), "ALL");

assert.deepEqual(categoryWhere("ALL"), {});
assert.deepEqual(categoryWhere("FRIENDS"), { type: { startsWith: "friend." } });
assert.deepEqual(categoryWhere("COMMUNITIES"), {
  AND: [
    { type: { startsWith: "community." } },
    {
      type: {
        notIn: [
          "chat.mention",
          "community.mention",
          "community.livestream_started",
          "community.livestream_ended",
        ],
      },
    },
  ],
});
assert.deepEqual(categoryWhere("MENTIONS"), {
  type: { in: ["chat.mention", "community.mention"] },
});
assert.deepEqual(categoryWhere("CALLS"), {
  OR: [{ type: { startsWith: "call." } }, { type: { in: ["CALL_MISSED"] } }],
});
assert.deepEqual(categoryWhere("SYSTEM"), {
  OR: [
    { type: { startsWith: "auth." } },
    { type: { startsWith: "admin." } },
    { type: { in: ["ANNOUNCEMENT", "MAINTENANCE", "UPDATE_REQUIRED"] } },
  ],
});

// ── Catalogue ids ───────────────────────────────────────────────────────────
// The six fixed ids, and only those. `ALL` is the client's no-filter state and
// is deliberately absent.
assert.deepEqual(
  [...NOTIFICATION_CATEGORY_IDS],
  ["FRIEND_REQUEST", "COMMUNITY", "MENTION", "CALLS", "SYSTEM", "LIVE_NOW"]
);
assert.deepEqual(
  NOTIFICATION_CATEGORY_SEED.map((c) => c.id),
  [...NOTIFICATION_CATEGORY_IDS]
);
assert.deepEqual(
  NOTIFICATION_CATEGORY_SEED.map((c) => c.priority),
  [1, 2, 3, 4, 5, 6]
);

assert.equal(categorizeId("friend.requested"), "FRIEND_REQUEST");
assert.equal(categorizeId("community.member_added"), "COMMUNITY");
assert.equal(categorizeId("chat.mention"), "MENTION");
assert.equal(categorizeId("call.activity"), "CALLS");
assert.equal(categorizeId("auth.security_new_login"), "SYSTEM");
// Livestream rows get their own catalogue id but keep the legacy COMMUNITIES
// bucket on `NotificationDTO.category` — released clients read that field.
assert.equal(categorizeId("community.livestream_started"), "LIVE_NOW");
assert.equal(categorizeId("community.livestream_ended"), "LIVE_NOW");
assert.equal(categorize("community.livestream_ended"), "COMMUNITIES");

// Legacy names and catalogue ids filter identically.
assert.deepEqual(categoryWhere("FRIEND_REQUEST"), categoryWhere("FRIENDS"));
assert.deepEqual(categoryWhere("COMMUNITY"), categoryWhere("COMMUNITIES"));
assert.deepEqual(categoryWhere("MENTION"), categoryWhere("MENTIONS"));
assert.deepEqual(categoryWhere("LIVE_NOW"), {
  type: {
    in: ["community.livestream_started", "community.livestream_ended"],
  },
});

// The echo keeps the caller's own vocabulary; canonicalization is separate.
assert.equal(parseCategory("friend_request"), "FRIEND_REQUEST");
assert.equal(parseCategory("communities"), "COMMUNITIES");
assert.equal(canonicalCategoryId("COMMUNITIES"), "COMMUNITY");
assert.equal(canonicalCategoryId("COMMUNITY"), "COMMUNITY");
assert.equal(canonicalCategoryId("ALL"), null);
assert.equal(canonicalCategoryId("bogus"), null);

assert.equal(parsePlatform("web"), "WEB");
assert.equal(parsePlatform("ANDROID"), "ANDROID");
assert.equal(parsePlatform("ios"), "IOS");
assert.equal(parsePlatform("desktop"), null);
assert.equal(parsePlatform(undefined), null);

// Every catalogue bucket is disjoint, so a type lands in exactly one bucket — this is what
// keeps the per-tab unread counts from double-counting a row.
for (const type of [
  "friend.requested",
  "call.activity",
  "CALL_MISSED",
  "community.member_added",
  "chat.mention",
  "auth.security_new_login",
  "community.livestream_started",
]) {
  const hits = NOTIFICATION_CATEGORY_IDS.filter(
    (cat) => categorizeId(type) === cat
  );
  assert.equal(
    hits.length,
    1,
    `${type} landed in ${String(hits.length)} categories`
  );
}

// eslint-disable-next-line no-console
console.log("notification-category.check ok");

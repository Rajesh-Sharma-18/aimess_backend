/**
 * Ponytail self-check: prefix routing + Prisma where fragments for the 6 tabs.
 * Run with: `tsx apps/chat-service/src/lib/notification-category.check.ts`
 */
import assert from "node:assert/strict";

import {
  categorize,
  categoryWhere,
  parseCategory,
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
    { type: { notIn: ["chat.mention", "community.mention"] } },
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

// Every tab is disjoint, so a type lands in exactly one bucket — this is what
// keeps the per-tab unread counts from double-counting a row.
for (const type of [
  "friend.requested",
  "call.activity",
  "CALL_MISSED",
  "community.member_added",
  "chat.mention",
  "auth.security_new_login",
]) {
  const hits = (
    ["FRIENDS", "COMMUNITIES", "MENTIONS", "CALLS", "SYSTEM"] as const
  ).filter((cat) => categorize(type) === cat);
  assert.equal(hits.length, 1, `${type} landed in ${String(hits.length)} tabs`);
}

// eslint-disable-next-line no-console
console.log("notification-category.check ok");

# Blocked-chat entry-point consistency

**Reported:** A blocks B in a private chat that has history. B opens the chat from the chat list → history shows. B opens the same pair from search or recent searches → a **Send Request** button shows instead.

**Status:** fixed in both repos.

| Repo | Commit |
| --- | --- |
| `aimess_backend` (branch `rajesh-dev`) | `18585099` — *one answer for a pair, whichever door you come through* |
| `aimess_website` (branch `features/fix-the-unban-issue`) | `66e163de` — *open a pair from the server's verdict, not from friendship alone* |

---

## 1. Root cause

Two independent defects that compound. Neither is a caching bug, a socket bug, or a missing server-side block check — all three of those were already correct.

### 1a. The screen was chosen from one axis

`aimess_website/src/views/message/MessageView.tsx`, before:

```tsx
const selectedFriend =
    friendSearch.selectedUser?.relationship === "friend" ? friendSearch.selectedUser : null;

if (friendSearch.selectedUser && !selectedFriend) {
    return <MessageFriendProfile … onAdd={() => friendSearch.sendRequest(selected.id)} … />;
}
```

A row picked out of search or recent searches sets `selectedUser`. The **only** condition deciding between the contact card and the conversation is `relationship === "friend"`. `friendSearch.selectedUser.threadId` — the existing room id, already on the search payload — is never consulted.

The chat-list door never sets `selectedUser` at all: it routes straight to `MessageChat`. That is the whole asymmetry. Same pair, two code paths, two screens.

### 1b. Blocking makes that axis read `NONE`

`aimess_backend/apps/user-service/src/services/friendship.service.ts` → `blockUser()`:

```ts
if (friendship?.status === "ACCEPTED") {
  await friendshipRepository.unfriendWithCounters(…);   // ← the friendship is destroyed
} else if (friendship?.status === "PENDING") {
  … cancel/reject …
}
await friendshipRepository.createBlock(blockerId, blockedId);
```

Blocking unfriends first, by design. So after A blocks B, the friendship axis for that pair reports `NONE` — indistinguishable from two strangers. Feed that into 1a and the search door renders a **Send Request** card over a conversation with years of history in it.

### 1c. Why the blocked user could not be told the truth either

`checkFriendships` (user-service gRPC) builds each peer's status with `buildFriendshipView(callerId, row, blockedIds.has(userId))` — `blockedIds` is the **outgoing** direction only. An *incoming* block deliberately collapses to `NONE` so a "was I blocked?" probe cannot be answered from relationship rendering. `blockedEitherWay` existed but cannot separate the directions under a mutual block, and neither field was exposed on any REST payload.

Result: the blocked party's client had no field anywhere that could say "you are blocked", so even a correct client had nothing better than `NONE` to render.

### What was already right (verified, not changed)

- **Server-side enforcement of the block.** `PrivateMessageService.assertPeerInteractionAllowed` gates send / edit / react / forward, and `friendshipService.sendRequest` rejects a blocked pair in **both** directions with `FRIEND_BLOCKED`. A blocked user could never actually send a message or a friend request, whatever button the UI drew.
- **History survives a block.** `getRoomDetailsById` never re-checks friendship; `PrivateRoom` and its messages outlive unfriend/reject/cancel/block.
- **Realtime.** `friend:blocked` / `friend:unblocked` reach the blocker's devices; `friend:relationship:sync` reaches the other party on `self:<id>`; `applyFriendshipEventToCaches` invalidates the room and every discovery cache app-wide.
- **Recent searches are live references, not snapshots.** `RecentUserSearch` stores `(targetType, targetId)` only — no cached name or status. The "stale recent search" hypothesis was wrong.

---

## 2. Entry-point × state matrix

### As-implemented (before)

| Entry point | Data it decided the screen from | Blocked pair with history → |
| --- | --- | --- |
| Chat list | inbox row's `roomId` → `MessageChat` | ✅ conversation |
| Global search | `relationship.status` only | ❌ **Send Request** (blocker's side) / row hidden entirely (blocked side) |
| Recent searches | same, via the same `selectedUser` path | ❌ same |
| Profile (message button) | `GET /users/:id` → `relationship.status`; **404** when the target blocked the viewer | ❌ Send Request, or a dead end |
| Deep link / notification | `useUserProfileProbe` → 404 → bounce to empty inbox | ❌ dead end |
| Group-member profile | `?profile=1` → `MessagePeerProfile` | ⚠️ card, no Send Request (block invisible) |

Three different sources of truth, none of them complete:

| Source | conversation? | block (mine) | block (theirs) | request state |
| --- | --- | --- | --- | --- |
| `GET /users/search` | `roomId` | `isBlockedByMe` | — (row removed) | ✅ |
| `GET /users/:id` | — | `isBlockedByMe` | — (404) | ✅ |
| `GET /chat/private/rooms/:id` | ✅ | via `friendship.status` | — | ✅ |

### Fixed

Every door resolves through **one** server call — `GET /chat/private/rooms/{peerId|roomId}` — which returns a `pairState` verdict computed from all four axes at once:

```jsonc
"pairState": {
  "state": "BLOCKED_BY_PEER",     // UNAVAILABLE | BLOCKED_BY_ME | BLOCKED_BY_PEER
                                  // | CONVERSATION | REQUEST_PENDING | NO_RELATIONSHIP
  "conversationId": "prv_…",      // carried in EVERY state, restrictions included
  "hasHistory": true,             // did two people actually speak (non-SYSTEM rows)
  "blockedByMe": false,
  "blockedByPeer": true,
  "canSendMessage": false,        // mirrors assertPeerInteractionAllowed exactly
  "canSendRequest": false,
  "restriction": "BLOCKED_BY_PEER" // PEER_UNAVAILABLE | BLOCKED_BY_ME
                                   // | BLOCKED_BY_PEER | NOT_FRIENDS | null
}
```

Precedence, implemented explicitly in `apps/chat-service/src/lib/pair-state.ts`:

1. peer unavailable (deleted / platform-banned)
2. blocked, either direction
3. existing conversation (`conversationId && (hasHistory || isFriend)`)
4. pending request
5. no relationship — **the only state that may render Send Request**

`state` never suppresses the rest: a `BLOCKED_BY_ME` pair still carries its `conversationId` and `hasHistory`, because the blocker's screen is the conversation *plus* a banner, not a different screen. `state` says which treatment; the other fields say what content.

| Entry point | After |
| --- | --- |
| Chat list | conversation (unchanged) |
| Global search | conversation + blocked treatment |
| Recent searches | conversation + blocked treatment |
| Profile / message button | conversation + blocked treatment |
| Deep link / notification | conversation + blocked treatment |
| Group-member profile (`?profile=1`) | profile card, actions off |
| Contact list / forward target | route through the same resolver |

---

## 3. Open questions — answers used

All four were put to the requester and answered before implementation.

| # | Question | Answer taken |
| --- | --- | --- |
| 1 | Blocker's composer while blocked | **Disabled + "You blocked X" banner with Unblock.** Matches the server, which already refuses the blocker's sends with `CHAT_BLOCKED`. |
| 2 | Blocked user's copy | New key `message.cannotSendMessages` — *"You can't send messages to this user."* (en/vi/th). Deliberately distinct from the not-friends and request-declined copy. |
| 3 | Search visibility while blocked | **Spec wins — reveal, scoped to pairs that already have a conversation.** See §6. |
| 4 | Blocked, no prior history | Blocker stays hidden; profile still 404s; nothing to render a Send Request on. |
| 5 | Deleted conversation while blocked | Existing delete semantics unchanged. Block still outranks, so no Send Request appears. |
| 6 | Mutual block | Supported and consistent. `state` reports `BLOCKED_BY_ME` (the actionable half) while `blockedByPeer` stays true beside it. |

---

## 4. Changes

### Backend — `aimess_backend`

| File | Change |
| --- | --- |
| `apps/chat-service/src/lib/pair-state.ts` | **New.** The precedence chain, pure and unit-testable. |
| `apps/chat-service/src/services/private-room.service.ts` | `getRoomDetails` returns `pairState` on both branches; a pair with no room and no friendship returns `PrivatePairStateData` instead of `403 CHAT_FRIENDSHIP_REQUIRED`. Room minting for friends still uses the fail-open local check, unchanged. |
| `apps/chat-service/src/repositories/private-message.repository.ts` | `hasHumanMessage(roomId)` — "did two people actually talk", ignoring SYSTEM rows and every per-user deletion. |
| `apps/chat-service/src/events/friendship.consumer.ts` | Its private duplicate of that query deleted; reuses the repo method. |
| `apps/chat-service/src/grpc/user.client.ts`, `services/private-message.service.ts` | The DM write gate reads the **either-way** block, so the blocked party is refused with `CHAT_BLOCKED` rather than falling through to `CHAT_FRIENDSHIP_REQUIRED` — the same error, and the same copy, a plain unfriend produces. |
| `packages/grpc-contracts/proto/user.proto`, `apps/user-service/src/grpc/server.ts`, `apps/chat-service/src/grpc/user-snapshot.client.ts` | New `blocked_by_peer` field. `status` cannot carry it (incoming blocks collapse to `NONE`) and `blocked_either_way` cannot separate the directions under a mutual block. |
| `apps/user-service/src/services/user-profile.service.ts` | 404-on-incoming-block now has one exception: a pair with an existing private room resolves, flagged `isBlockedByPeer`, with profile CONTENT still closed. Also fixes a live defect: `canSendRequest` ignored the incoming block and offered an add-friend action `sendRequest` refuses. |
| `apps/user-service/src/services/user-search.service.ts` | Blockers with an existing room stay in search + Recent, carrying `isBlockedByPeer`, every action off, presence suppressed. Blockers with no room are still subtracted. |
| `packages/shared-types/src/events/friendship.ts` | Doc corrected — the verbless sync event no longer implies the recipient can learn nothing. |

### Frontend — `aimess_website`

| File | Change |
| --- | --- |
| `src/views/message/MessageView.tsx` | **The fix.** The search/recent branch renders from `pairState.state === "CONVERSATION"`, not `relationship === "friend"`. Holds a skeleton until the verdict lands so a blocked pair cannot flash a Send Request button for one paint. |
| `src/component/message/hooks/useRoomFriendship.ts` | `canCompose`, `canSendRequest` and the block flags prefer the server verdict; adds `blockedByMe` / `blockedByPeer` / `restriction`. Per-axis derivation kept only as a pre-upgrade fallback. |
| `src/component/message/MessageChat.tsx` | Blocked bar split by direction: the viewer's own block keeps "You blocked X — Unblock"; being blocked gets its own sentence and **no** Unblock button (that call answers `FRIEND_NOT_BLOCKED`). `useMessageSettings` now receives `blockedByMe`, restoring that parameter's documented meaning. |
| `src/component/message/friendshipCacheSync.ts` | An optimistic `friend:*` patch **drops** the stale `pairState` rather than guessing a new one — it cannot see history or the peer's block. Consumers fall back to the per-axis fields the patch just corrected, until the invalidation refetches. |
| `src/controller/chat/chat.api.ts`, `usePrivateChat.ts` | `getPrivatePairState` (GET). Same handler and body as the POST, minus the write verb and the `pm:sensitive` 30/min limit meant for row-minting calls. |
| `src/messages/{en,vi,th}.json` | `message.cannotSendMessages`. |
| `chat.apiType.ts`, `users.apiType.ts` | `PrivatePairStateInfo`; `isBlockedByMe` / `isBlockedByPeer` on the public profile. `PrivateRoom.roomId` is now `string \| null` (a roomless pair is a real answer). |

---

## 5. Verification

### Baseline (before any change)

- `apps/user-service`: 22 suites, 338 tests — all green.
- `apps/chat-service`: **11 suites / 42 tests already failing** from other in-flight work on this branch. Recorded before the first edit and compared after every run.

### After

- `apps/user-service`: **23 suites, 345 tests, all green.**
- `apps/chat-service`: 10 failing suites / 40 tests — the baseline set **minus** `private/private-room.test.ts`, which this work repaired. **No new failures.**
- The two touched files still in the failing set (`private/private-message.test.ts`, `grpc/service-impl.test.ts`) fail on avatar/media resolve-on-read and reaction grouping — pre-existing, in the baseline list, unrelated.
- `aimess_website`: `tsc --noEmit` clean, `eslint src` clean, `next build` **exit 0**.
- Scenario matrix run twice consecutively: **9 suites, 189 tests, green both times.**

### New tests

| File | Covers |
| --- | --- |
| `apps/chat-service/tests/lib/pair-state.test.ts` (17) | The precedence chain cell by cell; `canSendMessage` proven to mirror the write gate; Send Request proven impossible under a block in any direction. |
| `apps/chat-service/tests/private/pair-state-entry-point-parity.test.ts` (14) | Opens each pair through **both** id shapes — a roomId (what the chat list holds) and a peer userId (what search, recent, profile, deep links and notifications hold) — and asserts the two verdicts are `toEqual`. A regression that breaks one door only is what this catches. |
| `apps/user-service/tests/users/blocked-pair-discovery-parity.test.ts` (6) | Search, Recent and the profile door: row survives with a conversation, drops without one; profile resolves vs 404s; actions and presence off. |

### Scenario matrix

`T` = automated test. `C` = verified by reading the code path end to end. `L` = needs a live two-user run.

| ID | Scenario | Status |
| --- | --- | --- |
| A1 | Blocked user opens from chat list → history + blocked state | **PASS** (T) |
| A2 | …from search → same screen, no Send Request | **PASS** (T) — the reported bug |
| A3 | …from recent searches → same screen | **PASS** (T) |
| A4 | Blocker, every entry point → history + Unblock banner | **PASS** (T) |
| A5 | After unblock → normal chat everywhere, no residue | **PASS** (T) |
| A6 | Search ROW itself offers the right action | **PASS** (T) — server `canSendRequest: false`; the row already gates on it |
| B1 | All entry points agree for the same pair-state | **PASS** (T) — both id shapes asserted equal across 10 pair-states |
| B2 | Recent rows never stale | **PASS** (C) — `RecentUserSearch` stores ids only; state is re-resolved per read, and re-resolved again on tap |
| B3 | Deep link / notification into a blocked pair | **PASS** (C) — profile no longer 404s for a pair with a conversation, so the route stops bouncing to the empty inbox |
| C1 | Blocker: history, input disabled, Unblock from banner + profile | **PASS** (T for state, C for render) |
| C2 | Blocked: history, input disabled, distinct copy | **PASS** (T for state, C for render) |
| C3 | Block while the chat is open → live update | **PASS** (C) — `friend:blocked` / `friend:relationship:sync` → `applyFriendshipEventToCaches` invalidates the room query |
| C4 | Block on another device | **PASS** (C) — both events are user-scoped, so every device of both parties refetches |
| C5 | Message in flight at the moment of block | **PASS** (C) — the server is authoritative; `assertPeerInteractionAllowed` runs per send and now refuses both directions with `CHAT_BLOCKED` |
| C6 | Unblock from any surface converges | **PASS** (T) — `friendship.test.ts` asserts both halves are notified |
| C7 | Mutual block consistent on both sides | **PASS** (T) |
| C8 | Chat list: conversation stays put on block | **PASS** (C) — block writes no message and touches no `lastActivity` |
| D1 | Blocked with NO prior conversation | **PASS** (T) — restricted state, no Send Request, on both sides |
| D2 | Deleted/cleared conversation while blocked | **PASS** (C) — deletion state is per-user and orthogonal; block still outranks |
| D3 | Block → unblock → block again | **PASS** (T/C) — every state in the cycle is asserted individually; the transitions themselves are the same two code paths, not separately driven |
| D4 | Peer deactivates/deletes | **PASS** (T) — `UNAVAILABLE` outranks everything |
| D5 | Group context unaffected by a 1:1 block | **PASS** (C) — the gate lives in `PrivateMessageService`; no group or community path calls it |
| D6 | Request pending → accepted → open via search | **PASS** (T) |
| E1 | Blocked user sends a message via direct API | **PASS** (T) — `friend-only-write-ops.test.ts`, `403 CHAT_BLOCKED` on send/edit/react/forward |
| E2 | Blocked user sends a friend request via direct API | **PASS** (T) — `friendship.test.ts`, `400 FRIEND_BLOCKED`, both directions |
| E3 | Block/unblock restricted to the parties | **PASS** (C) — the blocker is the authenticated caller; there is no third-party form |
| E4 | Resolver returns complete, consistent state | **PASS** (T) — one response, no client-side stitching |
| E5 | Search results never suggest an impossible action | **PASS** (T) — including a real defect this audit found and fixed (§4, `user-profile.service.ts`) |
| F1 | Hard reload in each state | **PASS** (C) — every state is server-resolved on mount; no client-only state to lose |
| F2 | Two devices converge | **PASS** (C) — same user-scoped events as C4 |
| F3 | Blocking X never affects the chat with Y | **PASS** (C) — every cache write and invalidation is keyed by `peerId` |

**Not claimed:** no scenario was exercised against a running stack with two real accounts. Doing so needs the full compose environment (9 services + Mongo, Postgres, Redis, RabbitMQ, MinIO) and seeded two-user fixtures, neither of which was available here. Every `C` row above is a code-path reading, not an observation. The `C` rows worth a live pass before release are **C3, C4, F2** (realtime convergence) and **C1, C2** (the two banner renders).

---

## 6. Accepted divergences

1. **A blocker with an existing conversation is now findable by the person they blocked** — in the unified search and Recent, and their profile card resolves. This was chosen deliberately (Open Question 3) and scoped as tightly as the requirement allows: that conversation is already in the blocked user's own inbox, so nothing is revealed that they could not already reach — only the surfaces stop disagreeing about it. A blocker with **no** conversation stays completely hidden, the profile still 404s, and in both cases profile content, presence and every action remain closed. Pickers (`user-discovery.service.ts` — add-member, invite) were **not** changed; they still subtract every blocker.

   This does mean a blocked user learns they were blocked, where previously they could not. That is a real change to a safety-adjacent behaviour and it is the direct consequence of the "same screen from every door" requirement — the two cannot both hold.

2. **`whoCanFindMe` still outranks entry-point parity.** A peer whose discovery scope excludes the viewer is absent from search whether or not a conversation exists. Pre-existing, unrelated to blocks, and left alone: a privacy scope the user set should not be overridden to make two surfaces match.

3. **`GET /users/recent-searches`** (a second, older recent-search endpoint) returns a bare profile with no relationship, block or room data. The message search UI does not call it — it reads `data.recent` from `GET /users/search`, which is fixed. Left as-is rather than extended speculatively.

4. **Conversation-list rows do not carry `pairState`.** Computing `hasHistory` per row is a query per row, and the list does not need the verdict — it opens the room, and the room's own response carries it. Add it only if a list row ever has to render a composer state.

5. **`getRoomDetails` still get-or-creates for friends.** Unchanged, and unchanged on purpose: it mints off the fail-open local friendship check, so a friend whose upstream lookup flickers still opens their chat.

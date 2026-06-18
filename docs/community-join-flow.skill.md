---
name: community-join-flow
description: >
  Frontend guide for the AIMess community JOIN flow. Use whenever building or
  debugging the "Join" / "Request to Join" button, the joined-communities list,
  member counts, join-request approval/rejection screens, or why a community
  doesn't appear/disappear without a page refresh. Covers the single join
  endpoint and its three outcomes, the PUBLIC (instant) vs PRIVATE (approval)
  flows step by step, the real-time socket events that flip the UI, the
  notifications + deep-links, and every edge case (already-member, banned,
  pending, cancel, reactivation).
---

# Community Join Flow — Frontend Guide (plain English)

This explains how a user joins a community and how your UI should react. Read
the **TL;DR** and **the one endpoint**, then the flow that matches your screen.

> Base URL: everything below is under the gateway → `/api/v1/communities`.
> All requests need the user's auth (Bearer access token). Timestamps in
> responses are epoch milliseconds; socket payloads send ISO-8601 where noted.

---

## TL;DR — there are only two behaviors

| Community `type` | What "Join" does                                        | Approval? |
| ---------------- | ------------------------------------------------------- | --------- |
| **PUBLIC**       | Joins **instantly** — the user is a member right away   | No        |
| **PRIVATE**      | Sends a **join request** that an admin/mod must approve | Yes       |

You do **not** decide which flow to run. You call **one endpoint** and the
response tells you what happened.

---

## How your UI knows the current state (before the user taps anything)

The community object (from get-community / list) already carries the join state.
Render the button from these fields — never guess:

| Field               | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `type`              | `"PUBLIC"` or `"PRIVATE"`                                                 |
| `isJoined`          | `true` → the user is an active member                                     |
| `role`              | `"ADMIN"` / `"MODERATOR"` / `"MEMBER"` / `null`                           |
| `joinRequestId`     | non-null → the user has a **pending** request → show "Requested" + Cancel |
| `joinRequestStatus` | `"PENDING"` / `null` (cleared once approved/rejected/cancelled)           |
| `memberCount`       | number to display                                                         |

---

## The one endpoint you call: `POST /api/v1/communities/:id/join`

No body needed. The response envelope is `{ success, message, data }`, and
**`data.status`** is the discriminator. Three possible outcomes:

| `data.status`     | HTTP | `data` shape                                      | Meaning → what you do                                                   |
| ----------------- | ---- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `JOINED`          | 201  | `{ status, membershipStatus:"ACTIVE", member }`   | PUBLIC join succeeded → user is now a member                            |
| `ALREADY_MEMBER`  | 200  | `{ status, membershipStatus:"ACTIVE", member }`   | They were already in → treat exactly like JOINED (safe to ignore/retry) |
| `REQUEST_CREATED` | 201  | `{ status, membershipStatus:"PENDING", request }` | PRIVATE → a request was created, waiting for admin                      |

```jsonc
// PUBLIC success
{ "success": true, "message": "Joined community",
  "data": { "status": "JOINED", "membershipStatus": "ACTIVE", "member": { /* role, status, joinedAt... */ } } }

// PRIVATE success
{ "success": true, "message": "Join request created",
  "data": { "status": "REQUEST_CREATED", "membershipStatus": "PENDING", "request": { "id": "...", "status": "PENDING", "createdAt": 0 } } }
```

**Frontend rule:** branch on `data.status`, not on HTTP code.

```ts
const { data } = await api.post(`/communities/${id}/join`);
switch (data.status) {
  case "JOINED":
  case "ALREADY_MEMBER":
    markAsJoined(id); // button → "Open", add to my-communities, memberCount++
    break;
  case "REQUEST_CREATED":
    markAsRequested(id, data.request.id); // button → "Requested" + Cancel
    break;
}
```

---

## Flow A — PUBLIC community (instant join)

```
User taps "Join"
      │
      ▼
POST /communities/:id/join
      │
      ▼
201 { status: "JOINED", membershipStatus: "ACTIVE", member }
      │
      ├─ Button → "Open" / "Joined"
      ├─ Add community to "My Communities" list
      ├─ memberCount + 1
      └─ Chat access is now granted
```

**Step by step**

1. User taps **Join**.
2. `POST /communities/:id/join`.
3. Response `JOINED` (201) or `ALREADY_MEMBER` (200) — handle both the same way.
4. Update UI immediately (optimistic is fine): mark joined, add to the joined
   list, bump `memberCount`, enable chat.
5. **Real-time confirmation** (for the user's _other_ devices / to reconcile):
   the user also receives **`community:joined`** on the **`/notify`** socket —
   flip the UI if it isn't already.
6. The user gets an in-app notification + push: **"Joined a community"**
   (`type: community.member_joined`).

> No admin action, no request, no queue. Public = done.

---

## Flow B — PRIVATE community (request → approval)

This is two phases: the requester sends a request, then an admin decides. The
key frontend job is **reacting in real time when the decision comes back** (no
refresh).

### B1 — Sending the request (requester app)

1. User taps **Join** (label it "Request to Join" for private).
2. `POST /communities/:id/join` → `201 { status:"REQUEST_CREATED",
membershipStatus:"PENDING", request }`.
3. Update UI:
   - Button → **"Requested"** + a **Cancel** option.
   - Do **NOT** add to the joined list.
   - Do **NOT** open chat.
4. (Optional) To send a request **with a message**, use
   `POST /communities/:id/join-requests` with body `{ "message": "…" }`.
   The plain `POST /join` is the no-message shortcut.
5. Admins/moderators are notified (in-app + push, `type:
community.join_requested`, deep-link → **COMMUNITY_REQUESTS**).

### B2 — While the request is pending (requester app)

- The community object now returns `joinRequestId` + `joinRequestStatus:
"PENDING"` → render "Requested" + Cancel.
- **Cancel my request:** `DELETE /communities/:id/join-requests/mine` →
  button goes back to "Join".
- **List all my pending requests** (across communities, e.g. a "Requests" tab):
  `GET /api/v1/communities/join-requests/mine`.

### B3 — Admin decides (admin/mod app)

- See pending requests: `GET /communities/:id/join-requests`.
- **Approve:** `POST /communities/:id/join-requests/:requestId/approve`.
- **Reject:** `POST /communities/:id/join-requests/:requestId/reject`.
- Bulk: `POST .../join-requests/bulk-approve` and `.../bulk-reject`.

### B4 — Requester sees the result LIVE (the important part)

The requester does **not** poll. Listen on the **`/notify`** socket for
**`community:join_request:update`**:

```jsonc
{
  "communityId": "…",
  "requestId": "…",
  "status": "APPROVED", // or "REJECTED"
  "communityName": "…",
  "decidedAt": "2026-06-18T10:00:00.000Z",
  "navigation": {
    "screen": "COMMUNITY_DETAILS",
    "communityId": "…",
    "communityName": "…",
  },
}
```

- **APPROVED** → flip button to **"Open"/"Joined"**, add to My Communities,
  update `memberCount`, grant chat.
- **REJECTED** → button back to **"Join"**, clear the pending state.

Alongside the socket event, an in-app `notification:new` + push also arrive
(`community.join_request_approved` / `community.join_request_rejected`).
On **approve**, the community **room** additionally gets
**`community:member:joined`** on the **`/community`** namespace, so existing
members' rosters/member counts update too.

```
Requester        Admin app                 Requester (live, no refresh)
   │  POST /join     │                            │
   ├────────────────▶│  (request shows as PENDING)│
   │  "Requested"    │                            │
   │                 │  POST .../approve          │
   │                 ├───────────────────────────▶│  community:join_request:update {APPROVED}
   │                 │                            ├─ button → "Open"
   │                 │                            ├─ add to My Communities
   │                 │                            └─ memberCount updates
```

---

## Real-time events cheat sheet

Open the sockets you already use; these are the join-relevant events.

| Namespace    | Event                           | Sent to            | When                                               | Payload (key fields)                                                                              |
| ------------ | ------------------------------- | ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/notify`    | `community:joined`              | the joiner         | PUBLIC self-join succeeded                         | `{ communityId, communityName, communityHandle, communityAvatarUrl, reactivated }`                |
| `/notify`    | `community:join_request:update` | the requester      | admin approves/rejects                             | `{ communityId, requestId, status:"APPROVED"\|"REJECTED", communityName, decidedAt, navigation }` |
| `/community` | `community:member:joined`       | the community room | a new member becomes active (incl. after approval) | community + member info (refresh roster / count)                                                  |

> Plus the generic `notification:new` (an inbox item) and `notification:count_update`
> (badge) fire on `/notify` for all of the above.

---

## Notifications + deep-links cheat sheet

| Notification `type`               | Goes to             | Tap → screen           |
| --------------------------------- | ------------------- | ---------------------- |
| `community.member_joined`         | the joiner (public) | COMMUNITY_DETAILS      |
| `community.join_requested`        | admins + moderators | **COMMUNITY_REQUESTS** |
| `community.join_request_approved` | the requester       | COMMUNITY_DETAILS      |
| `community.join_request_rejected` | the requester       | COMMUNITY_DETAILS      |

**Data-encoding gotcha (important):**

- **Push (FCM) `data`** values are **JSON strings** → `JSON.parse` the
  `navigation` / `actorSnapshot` fields.
- **Socket** payloads are already **parsed objects** → use directly.
- **REST** notification `payload.data` values are **JSON strings** → parse them.

---

## Member count & "My Communities" list sync

- After `JOINED` / after an **approved** request: add the community to the
  user's list and bump `memberCount`. You can optimistically update, then
  reconcile with `GET /api/v1/communities/mine`.
- After **leave / reject / cancel**: remove it / decrement and clear pending.

---

## Edge cases & gotchas (don't ship without these)

| Situation                                                | What the API does                                                 | What the UI should do                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| User already a member, taps Join again                   | `200 ALREADY_MEMBER`                                              | Treat as joined; safe to ignore. Idempotent — retries are safe.   |
| Private + already has a pending request, taps Join again | Returns the **existing** pending request (idempotent)             | Keep showing "Requested"                                          |
| Previously left a PUBLIC community, rejoins              | `JOINED` with `reactivated: true` on the `community:joined` event | Same as a fresh join                                              |
| User is **banned** from the community                    | `403` (`COMMUNITY_JOIN_BANNED`)                                   | Show "You can't join this community" — don't show a generic error |
| Community missing / suspended                            | `404`                                                             | "Community not available"                                         |
| Request was **rejected** earlier                         | `joinRequestStatus` is `null` again                               | Button shows "Join" — they may request again                      |
| Requester cancels                                        | request removed                                                   | Button back to "Join"                                             |

---

## Button-state decision table

| `type`  | `isJoined` | `joinRequestStatus` | Button                   | Action                                    |
| ------- | ---------- | ------------------- | ------------------------ | ----------------------------------------- |
| PUBLIC  | false      | —                   | **Join**                 | `POST /join` → instant                    |
| PUBLIC  | true       | —                   | **Open**                 | go to community                           |
| PRIVATE | false      | `null`              | **Request to Join**      | `POST /join` → pending                    |
| PRIVATE | false      | `PENDING`           | **Requested** (+ Cancel) | `DELETE .../join-requests/mine` to cancel |
| PRIVATE | true       | —                   | **Open**                 | go to community                           |
| any     | —          | — (banned)          | **Disabled**             | show "can't join"                         |

---

## Frontend checklist

- [ ] Use the single `POST /communities/:id/join`; branch on `data.status`
      (`JOINED` / `ALREADY_MEMBER` / `REQUEST_CREATED`).
- [ ] Render the button from the community payload (`type`, `isJoined`,
      `joinRequestStatus`) — don't infer from the type alone.
- [ ] Open the `/notify` socket and handle `community:joined` and
      `community:join_request:update` to flip the UI **without a refresh**.
- [ ] (If you show rosters) handle `community:member:joined` on `/community`.
- [ ] Update `memberCount` + "My Communities" on join/approve; reconcile with
      `GET /communities/mine`.
- [ ] Handle `403` (banned) and `404` distinctly from generic errors.
- [ ] Parse JSON-string `navigation`/`actorSnapshot` from push + REST (socket is
      already parsed); deep-link to COMMUNITY_REQUESTS (admins) /
      COMMUNITY_DETAILS (requester).
- [ ] Provide Cancel for pending private requests
      (`DELETE /communities/:id/join-requests/mine`).

---

## Endpoint reference (all under `/api/v1/communities`)

| Method | Path                                    | Who       | Purpose                                              |
| ------ | --------------------------------------- | --------- | ---------------------------------------------------- |
| POST   | `/:id/join`                             | any user  | Smart join (instant for public, request for private) |
| POST   | `/:id/join-requests`                    | any user  | Request to join **with a message**                   |
| GET    | `/join-requests/mine`                   | any user  | My pending requests (all communities)                |
| DELETE | `/:id/join-requests/mine`               | requester | Cancel my pending request                            |
| GET    | `/:id/join-requests`                    | admin/mod | List this community's pending requests               |
| POST   | `/:id/join-requests/:requestId/approve` | admin/mod | Approve                                              |
| POST   | `/:id/join-requests/:requestId/reject`  | admin/mod | Reject                                               |
| POST   | `/:id/join-requests/bulk-approve`       | admin/mod | Approve many                                         |
| POST   | `/:id/join-requests/bulk-reject`        | admin/mod | Reject many                                          |
| GET    | `/mine`                                 | any user  | My joined communities                                |

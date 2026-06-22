---
name: auth-community-api-changes-june-2026
description: >
  Frontend change-log for all Auth Flow and Community API changes shipped
  between 2026-06-04 and 2026-06-18. Use whenever updating client-side code
  to match the new backend contracts: the POST /join discriminated response,
  new joinRequestId/joinRequestStatus fields on the community object, new bulk
  and like endpoints, removed internal auth routes, the uploads URL alias, and
  changed validation error messages.
---

# Auth + Community API Changes — FE Update Guide (June 2026)

This is your "what broke / what's new" reference. Skim the **Breaking Changes**
section first, then work through the new endpoints you need.

> Base URL: everything under the gateway → `/api/v1`.
> All requests need the user's Bearer access token unless stated otherwise.

---

## Breaking Changes (act on these first)

### 1. `POST /communities/:id/join` — response shape is now a discriminated union

**Old behaviour:** always returned `201` with a join-request DTO, even for
public communities.

**New behaviour:** returns one of three distinct shapes depending on `data.status`.
Branch on `data.status` — **do not** assume a join request was created.

| `data.status`       | HTTP | `data` shape                                      | When                                             |
| ------------------- | ---- | ------------------------------------------------- | ------------------------------------------------ |
| `"JOINED"`          | 201  | `{ status, membershipStatus:"ACTIVE", member }`   | PUBLIC community — user is now an active member  |
| `"ALREADY_MEMBER"`  | 200  | `{ status, membershipStatus:"ACTIVE", member }`   | User was already a member — treat same as JOINED |
| `"REQUEST_CREATED"` | 201  | `{ status, membershipStatus:"PENDING", request }` | PRIVATE community — a join request was created   |

```ts
const { data } = await api.post(`/communities/${id}/join`);

switch (data.status) {
  case "JOINED":
  case "ALREADY_MEMBER":
    markAsJoined(id); // button → "Open", add to list
    break;
  case "REQUEST_CREATED":
    markAsPending(id, data.request.id); // button → "Requested" + Cancel
    break;
}
```

See [`community-join-flow.skill.md`](./community-join-flow.skill.md) for the
complete flow, real-time events, and edge-case table.

---

### 2. `GET /communities/:id` — two new fields on the response object

The community object now includes the caller's join-request state so you can
render the correct button without an extra request.

```diff
{
  "id": "...",
  "type": "PUBLIC" | "PRIVATE",
  "isJoined": true | false,
+ "joinRequestId": "uuid" | null,       // non-null → caller has a PENDING request
+ "joinRequestStatus": "PENDING" | null // cleared once approved / rejected / cancelled
  ...
}
```

**Render the Join button from these three fields** (`isJoined`,
`joinRequestId`, `joinRequestStatus`) — never guess from `type` alone.

| `isJoined` | `joinRequestStatus` | Button to show                                           |
| ---------- | ------------------- | -------------------------------------------------------- |
| `true`     | —                   | **Open**                                                 |
| `false`    | `null`              | **Join** (public) / **Request to Join** (private)        |
| `false`    | `"PENDING"`         | **Requested** + Cancel (`DELETE .../join-requests/mine`) |

---

### 3. Internal auth routes removed

Two service-to-service routes were deleted. If any client code (BFF, internal
tooling) called these, remove those calls:

| Removed                                  | Was used for                                    |
| ---------------------------------------- | ----------------------------------------------- |
| `GET /api/internal/accounts?userIds=...` | Bulk-resolve `{ userId, account }` by UUID      |
| `GET /internal/account`                  | Single-user account lookup (service-to-service) |

---

### 4. Auth validation error messages changed

`400` responses from auth endpoints now use clearer field-level messages.
Update any client-side copy that echoes backend error strings, or any tests
that assert on specific `errors` strings.

| Field / context                | Old                                                  | New                                                                                                                        |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Account name min length        | `"Account name must be at least 3 characters long"`  | `"Account name must be at least 3 characters"`                                                                             |
| Account name max length        | `"Account name cannot be longer than 32 characters"` | `"Account name must be at most 32 characters"`                                                                             |
| Account name pattern           | `"…letters, numbers, and underscores"`               | `"…letters, numbers, **hyphens**, and underscores"`                                                                        |
| Email format                   | `"Invalid email address"`                            | `"Email is invalid"`                                                                                                       |
| OTP / verification code        | `"OTP must be a 6-digit code"`                       | `"Verification code must be exactly 6 digits"`                                                                             |
| FCM push token                 | `"FCM token cannot be empty"`                        | `"FCM token is required"`                                                                                                  |
| Account deletion password      | `"Password is required"`                             | `"Password is required to confirm account deletion"`                                                                       |
| Top-level `message` on any 400 | Always the generic `VALIDATION_FAILED` key           | Now the **first field error** (e.g. `"Email is invalid"`) — fall back to `VALIDATION_FAILED` only if no field error exists |

> **Account names now accept hyphens** — update any FE regex that validates
> the pattern locally.

---

## New Endpoints (additive — no action required unless you use them)

### Community — likes

| Method   | Path                    | Purpose                               |
| -------- | ----------------------- | ------------------------------------- |
| `POST`   | `/communities/:id/like` | Like a community                      |
| `DELETE` | `/communities/:id/like` | Unlike a community                    |
| `GET`    | `/communities/liked`    | List communities the caller has liked |

---

### Community — bulk operations

All bulk endpoints accept the same JWT the regular endpoints use.

| Method | Path                                          | Body                                        | Purpose                               |
| ------ | --------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `POST` | `/communities/mute/bulk`                      | `{ communityIds: string[] }`                | Mute multiple communities at once     |
| `POST` | `/communities/read/bulk`                      | `{ communityIds: string[] }`                | Mark multiple communities as read     |
| `POST` | `/communities/leave/bulk`                     | `{ communityIds: string[] }`                | Leave multiple communities            |
| `POST` | `/communities/:id/join-requests/bulk-approve` | `{ requestIds: string[] }`                  | Approve many join requests (mod+)     |
| `POST` | `/communities/:id/join-requests/bulk-reject`  | `{ requestIds: string[], reason?: string }` | Reject many join requests (mod+)      |
| `POST` | `/communities/:id/invite-links/bulk-send`     | `{ userIds: string[], linkId: string }`     | Send an invite link to multiple users |

---

### Community — cancel own join request

| Method   | Path                                  | Purpose                                      |
| -------- | ------------------------------------- | -------------------------------------------- |
| `DELETE` | `/communities/:id/join-requests/mine` | Cancel the caller's own pending join request |

> This is preferred over `DELETE /:id/join-requests/:requestId` for the
> self-service case — no need to store the `requestId` on the client.

---

### Community — platform-admin category management

These are gated by a platform-admin role. Only relevant to the admin panel.

| Method   | Path                                  | Purpose                                |
| -------- | ------------------------------------- | -------------------------------------- |
| `GET`    | `/communities/categories/admin`       | List all categories including inactive |
| `POST`   | `/communities/categories`             | Create a category                      |
| `PATCH`  | `/communities/categories/:categoryId` | Update a category                      |
| `DELETE` | `/communities/categories/:categoryId` | Delete a category                      |

The existing `GET /communities/categories` (no `/admin`) is unchanged — still
returns active categories only, no auth required.

---

### Avatar uploads alias (legacy path kept working)

`POST /api/v1/users/uploads/url` is now a **stable alias** that forwards to
the centralized media-service. The request and response shapes are unchanged
from the client's perspective:

**Request:**

```jsonc
{
  "type": "AVATAR", // only "AVATAR" is valid here
  "contentType": "image/jpeg",
  "contentLength": 204800,
}
```

**Response:** identical to the media-service upload-url response (presigned
upload URL + `media.downloadUrl`).

If you were already calling this path, no change needed. If you are calling
`POST /api/v1/media/upload-url` directly for avatars, both paths work.

---

## Join-request `decidedBy` shape change

If you render who approved/rejected a join request (e.g. in a notification
detail or history screen), the `decidedBy` object on approve/reject responses
and payloads now includes `displayName`:

```diff
"decidedBy": {
  "userId": "...",
  "username": "..." | null,
+ "displayName": "..."
}
```

---

## FE checklist

- [ ] Update `POST /communities/:id/join` handling to branch on `data.status`
      (`JOINED` / `ALREADY_MEMBER` / `REQUEST_CREATED`).
- [ ] Add `joinRequestId` + `joinRequestStatus` to your community DTO type and
      use them to drive the Join/Requested/Open button state.
- [ ] Remove any calls to the deleted internal auth routes
      (`/api/internal/accounts`, `/internal/account`).
- [ ] Update local validation copy / regexes that echoed the old auth error
      strings — especially account names now allowing hyphens.
- [ ] Update tests that assert on specific validation error message strings.
- [ ] Add Cancel button for private-community pending state using
      `DELETE /communities/:id/join-requests/mine`.
- [ ] Wire up bulk-mute / bulk-read / bulk-leave if your UI has multi-select.
- [ ] Wire up `POST/DELETE /:id/like` and `GET /liked` if the like feature is
      exposed in your build.
- [ ] Add `displayName` to your `decidedBy` type in join-request payloads.

---

## Quick reference — all changed endpoints

| Method   | Path                                          | Status                    | Notes                                                  |
| -------- | --------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| `POST`   | `/communities/:id/join`                       | **Changed**               | Discriminated union response — branch on `data.status` |
| `GET`    | `/communities/:id`                            | **Changed**               | Adds `joinRequestId` + `joinRequestStatus`             |
| `GET`    | `/api/internal/accounts`                      | **Removed**               | Deleted                                                |
| `GET`    | `/internal/account`                           | **Removed**               | Deleted                                                |
| `POST`   | `/api/v1/users/uploads/url`                   | **Changed (transparent)** | Now proxied to media-service; same interface           |
| `GET`    | `/communities/liked`                          | New                       |                                                        |
| `POST`   | `/communities/:id/like`                       | New                       |                                                        |
| `DELETE` | `/communities/:id/like`                       | New                       |                                                        |
| `POST`   | `/communities/mute/bulk`                      | New                       |                                                        |
| `POST`   | `/communities/read/bulk`                      | New                       |                                                        |
| `POST`   | `/communities/leave/bulk`                     | New                       |                                                        |
| `POST`   | `/communities/:id/join-requests/bulk-approve` | New                       |                                                        |
| `POST`   | `/communities/:id/join-requests/bulk-reject`  | New                       |                                                        |
| `DELETE` | `/communities/:id/join-requests/mine`         | New                       | Self-cancel                                            |
| `POST`   | `/communities/:id/invite-links/bulk-send`     | New                       |                                                        |
| `GET`    | `/communities/categories/admin`               | New                       | Admin only                                             |
| `POST`   | `/communities/categories`                     | New                       | Admin only                                             |
| `PATCH`  | `/communities/categories/:categoryId`         | New                       | Admin only                                             |
| `DELETE` | `/communities/categories/:categoryId`         | New                       | Admin only                                             |

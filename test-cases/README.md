# AIMess Backend — API & Event Test Case Repository

This repository contains **manual / automation-ready test cases** derived directly from the
implemented codebase (REST APIs, Socket.IO events, and business logic). Every test case maps to
real, shipped behavior in `apps/*`.

> Source of truth: `apps/*/src` (routes → controllers → services → repositories), the Socket.IO
> namespaces in `apps/api-gateway/src/sockets/`, and `docs/SOCKET_EVENTS.md`.

## Folder structure (by module)

```
test-cases/
├── auth/             # auth-service: login, register, OTP, sessions, social, account, email/password change, device link
├── users/            # user-service: profile, username, settings, account, avatar upload, user search, internal
├── friends/          # user-service: friend requests, friendship lifecycle, blocking
├── private-chat/     # chat-service: 1:1 messages, inbox, media upload, reactions, edit/delete, read receipts
├── group-chat/       # chat-service: group rooms, members, group messages, invite links, lifecycle/system messages
├── communities/      # chat-service + community-service: communities, channels, membership, moderation
├── calls/            # chat-service call.routes + api-gateway webrtc.routes: 1:1 / group call signaling
├── notifications/    # notifications-service + chat-service notification.routes: device tokens, push, unread counts, prefs
├── websocket-events/ # api-gateway /chat, /community, /notify namespaces: realtime contract
└── livestream/       # livestream-comment feature (partial) + gap analysis
```

## Test Case ID scheme

`TC-<MODULE>-<NNN>`

| Module        | Prefix |
| ------------- | ------ |
| auth          | AUTH   |
| users         | USER   |
| friends       | FRND   |
| private-chat  | PCHAT  |
| group-chat    | GCHAT  |
| communities   | COMM   |
| calls         | CALL   |
| notifications | NOTIF  |
| websocket     | WS     |
| livestream    | LIVE   |

Each `.md` file groups cases for one endpoint or event family. IDs are unique and stable.

## Test case format (required fields)

Every test case uses this table-backed block:

```markdown
### TC-AUTH-001 — <short title>

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Auth / Login                                           |
| **API/Event Name**        | `POST /api/v1/auth/login`                              |
| **Test Scenario**         | Happy path — valid credentials return tokens           |
| **Category**              | Happy Path                                             |
| **Priority**              | High                                                   |
| **Preconditions**         | A verified account exists for the email                |
| **Request Payload**       | `{ "email": "...", "password": "..." }`                |
| **Expected Response**     | `200` `{ accessToken, refreshToken, user }`            |
| **Expected DB Changes**   | New `Session` row; `lastLoginAt` updated               |
| **Expected Socket/Event** | `notify:session.created` (if applicable) — else `None` |
| **Notes**                 | Edge details, related TC links                         |
```

**Category** is one of: Happy Path · Input Validation · Required Params · Optional Params ·
AuthN · AuthZ · RBAC · Business Rule · DB State · Error Handling · Edge Case · Rate Limit ·
File Upload · Pagination/Filter/Sort · Concurrency · Security.

## Coverage index

See [`COVERAGE.md`](COVERAGE.md) for the endpoint/event → test-file matrix and identified gaps.

## Priority guidance

- **High** — auth, authorization/RBAC, data-integrity, money/irreversible actions, security.
- **Medium** — standard happy paths, validation, pagination, business rules.
- **Low** — cosmetic/optional fields, rare edge cases, non-blocking warnings.

# Communities — Join & Leave (community-service + invites/links)

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`POST /:id/join`, `POST /:id/leave`, join-requests, invites, invite-links), `services/community.service.ts` (`joinCommunity`, `leaveCommunity`, `createJoinRequest`, `approve/reject/cancelJoinRequest`, `createInvite`, `accept/declineInvite`, `createInviteLink`, `redeemInviteLink`, `revokeInviteLink`).

> **Service:** community-service. PUBLIC join is **request-based** (creates a PENDING join request — there is **no instant join**); PRIVATE requires an explicit invite/add. The `POST /:id/join` endpoint delegates to `createJoinRequest`.

---

## Direct join / leave

### TC-COMM-032 — Join PUBLIC community creates PENDING request

| Field                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join                                                               |
| **API/Event Name**        | `POST /api/v1/communities/:id/join`                                              |
| **Test Scenario**         | Non-member joins a PUBLIC community                                              |
| **Category**              | Happy Path                                                                       |
| **Priority**              | High                                                                             |
| **Preconditions**         | PUBLIC community; caller not a member                                            |
| **Request Payload**       | —                                                                                |
| **Expected Response**     | `201` `COMMUNITY_JOIN_REQUEST_CREATED` with join-request DTO (status PENDING)    |
| **Expected DB Changes**   | New `CommunityJoinRequest` PENDING; **no member row yet**, memberCount unchanged |
| **Expected Socket/Event** | RabbitMQ `community.join.requested` to ADMIN+MODERATOR recipients                |
| **Notes**                 | Join is NOT instant; a moderator must approve.                                   |

### TC-COMM-033 — Join PRIVATE community rejected

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| **Feature/Module**        | Communities / Join                            |
| **API/Event Name**        | `POST /api/v1/communities/:id/join`           |
| **Test Scenario**         | Self-join a PRIVATE community                 |
| **Category**              | Business Rule                                 |
| **Priority**              | High                                          |
| **Preconditions**         | PRIVATE community                             |
| **Request Payload**       | —                                             |
| **Expected Response**     | `403` `COMMUNITY_JOIN_REQUIRES_INVITE`        |
| **Expected DB Changes**   | None                                          |
| **Expected Socket/Event** | None                                          |
| **Notes**                 | `joinCommunity` blocks non-PUBLIC at the top. |

### TC-COMM-034 — Join when already ACTIVE member

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Communities / Join                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/join` |
| **Test Scenario**         | Existing member re-joins            |
| **Category**              | Business Rule                       |
| **Priority**              | Medium                              |
| **Preconditions**         | Caller already ACTIVE               |
| **Request Payload**       | —                                   |
| **Expected Response**     | `409` `COMMUNITY_ALREADY_MEMBER`    |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | Checked inside `createJoinRequest`. |

### TC-COMM-035 — Join when BANNED

| Field                     | Value                               |
| ------------------------- | ----------------------------------- |
| **Feature/Module**        | Communities / Join                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/join` |
| **Test Scenario**         | Banned user tries to join           |
| **Category**              | Security / Business Rule            |
| **Priority**              | High                                |
| **Preconditions**         | Caller member status BANNED         |
| **Request Payload**       | —                                   |
| **Expected Response**     | `403` `COMMUNITY_JOIN_BANNED`       |
| **Expected DB Changes**   | None                                |
| **Expected Socket/Event** | None                                |
| **Notes**                 | —                                   |

### TC-COMM-036 — Join idempotency (existing PENDING)

| Field                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join                                                          |
| **API/Event Name**        | `POST /api/v1/communities/:id/join`                                         |
| **Test Scenario**         | Caller already has a PENDING request, retries                               |
| **Category**              | Concurrency / Idempotency                                                   |
| **Priority**              | Medium                                                                      |
| **Preconditions**         | PENDING request exists                                                      |
| **Request Payload**       | —                                                                           |
| **Expected Response**     | `201` returns existing PENDING request unchanged                            |
| **Expected DB Changes**   | None (no duplicate); a terminal request is recycled to PENDING              |
| **Expected Socket/Event** | `community.join.requested` NOT re-emitted for the idempotent PENDING return |
| **Notes**                 | Recycled (REJECTED/CANCELLED → PENDING) DOES re-emit.                       |

### TC-COMM-037 — Leave community (non-admin member)

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Communities / Leave                                        |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`                       |
| **Test Scenario**         | Plain member leaves                                        |
| **Category**              | Happy Path                                                 |
| **Priority**              | High                                                       |
| **Preconditions**         | Caller ACTIVE MEMBER                                       |
| **Request Payload**       | `{}` or `{ "reason": "TOO_NOISY" }`                        |
| **Expected Response**     | `200` `COMMUNITY_LEFT`; member DTO status LEFT             |
| **Expected DB Changes**   | member → LEFT; memberCount recomputed; audit `MEMBER_LEFT` |
| **Expected Socket/Event** | None on `/community`                                       |
| **Notes**                 | Body optional; reason metadata stored in audit.            |

### TC-COMM-038 — Leave with reason OTHER but no reasonText

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Communities / Leave                                   |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`                  |
| **Test Scenario**         | reason=OTHER requires reasonText                      |
| **Category**              | Input Validation                                      |
| **Priority**              | Low                                                   |
| **Preconditions**         | Member                                                |
| **Request Payload**       | `{ "reason": "OTHER" }`                               |
| **Expected Response**     | `400` ("reasonText is required when reason is OTHER") |
| **Expected DB Changes**   | None                                                  |
| **Expected Socket/Event** | None                                                  |
| **Notes**                 | `leaveReasonSchema.refine`.                           |

### TC-COMM-039 — Admin leaves → auto-handover to oldest moderator

| Field                     | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Leave                                                                                                                                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`                                                                                                                 |
| **Test Scenario**         | Admin leaves; an ACTIVE moderator exists                                                                                                             |
| **Category**              | Business Rule                                                                                                                                        |
| **Priority**              | High                                                                                                                                                 |
| **Preconditions**         | Caller ADMIN; ≥1 ACTIVE MODERATOR                                                                                                                    |
| **Request Payload**       | `{}`                                                                                                                                                 |
| **Expected Response**     | `200`; leaving admin DTO LEFT                                                                                                                        |
| **Expected DB Changes**   | Oldest moderator → ADMIN; `adminId` transferred; old admin → MEMBER then LEFT; memberCount recomputed; audits `MEMBER_LEFT` then `ADMIN_TRANSFERRED` |
| **Expected Socket/Event** | RabbitMQ `community.admin.transferred` (reason `admin_left_auto_handover`)                                                                           |
| **Notes**                 | Successor preference: oldest MODERATOR → else oldest MEMBER.                                                                                         |

### TC-COMM-040 — Admin leaves → handover to oldest member (no mods)

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Communities / Leave                                   |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`                  |
| **Test Scenario**         | Admin leaves; no moderators, but ACTIVE members exist |
| **Category**              | Business Rule                                         |
| **Priority**              | High                                                  |
| **Preconditions**         | Caller ADMIN; no mods; ≥1 ACTIVE member               |
| **Request Payload**       | `{}`                                                  |
| **Expected Response**     | `200`                                                 |
| **Expected DB Changes**   | Oldest member → ADMIN; ownership transferred          |
| **Expected Socket/Event** | RabbitMQ `community.admin.transferred`                |
| **Notes**                 | —                                                     |

### TC-COMM-041 — Admin leaves as sole member → community auto-deleted

| Field                     | Value                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Leave                                                                                                                             |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`                                                                                                            |
| **Test Scenario**         | Admin is the only ACTIVE member                                                                                                                 |
| **Category**              | Business Rule                                                                                                                                   |
| **Priority**              | High                                                                                                                                            |
| **Preconditions**         | Caller ADMIN; no other ACTIVE members                                                                                                           |
| **Request Payload**       | `{}`                                                                                                                                            |
| **Expected Response**     | `200` member LEFT                                                                                                                               |
| **Expected DB Changes**   | `deletedAt` set; admin → LEFT; memberCount=0; audits `MEMBER_LEFT` + `COMMUNITY_DELETED` (reason `admin_left_no_successor`); caches invalidated |
| **Expected Socket/Event** | RabbitMQ `community.deleted` (memberIds=[admin]) + `community.deleted.for-chat`                                                                 |
| **Notes**                 | Soft-delete first.                                                                                                                              |

### TC-COMM-042 — Leave when not a member

| Field                     | Value                                     |
| ------------------------- | ----------------------------------------- |
| **Feature/Module**        | Communities / Leave                       |
| **API/Event Name**        | `POST /api/v1/communities/:id/leave`      |
| **Test Scenario**         | Non-member / LEFT / BANNED tries to leave |
| **Category**              | Error Handling                            |
| **Priority**              | Medium                                    |
| **Preconditions**         | No ACTIVE membership                      |
| **Request Payload**       | `{}`                                      |
| **Expected Response**     | `404` `COMMUNITY_MEMBER_NOT_FOUND`        |
| **Expected DB Changes**   | None                                      |
| **Expected Socket/Event** | None                                      |
| **Notes**                 | Only ACTIVE may leave.                    |

## Join requests (moderation of requests)

### TC-COMM-043 — Create join request with message

| Field                     | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                           |
| **API/Event Name**        | `POST /api/v1/communities/:id/join-requests`          |
| **Test Scenario**         | Explicit join request with optional message           |
| **Category**              | Happy Path                                            |
| **Priority**              | Medium                                                |
| **Preconditions**         | Non-member                                            |
| **Request Payload**       | `{ "message": "let me in" }` (≤500)                   |
| **Expected Response**     | `201` join-request DTO PENDING                        |
| **Expected DB Changes**   | New PENDING request                                   |
| **Expected Socket/Event** | RabbitMQ `community.join.requested`                   |
| **Notes**                 | Allowed for PUBLIC and PRIVATE here (unlike `/join`). |

### TC-COMM-044 — Approve join request (MODERATOR+)

| Field                     | Value                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                                                                                             |
| **API/Event Name**        | `POST /api/v1/communities/:id/join-requests/:requestId/approve`                                                         |
| **Test Scenario**         | Moderator approves a PENDING request                                                                                    |
| **Category**              | RBAC / Happy Path                                                                                                       |
| **Priority**              | High                                                                                                                    |
| **Preconditions**         | Caller MODERATOR+; request PENDING                                                                                      |
| **Request Payload**       | —                                                                                                                       |
| **Expected Response**     | `200` `{ request: APPROVED, member: ACTIVE }`                                                                           |
| **Expected DB Changes**   | Member created/reactivated ACTIVE; memberCount++; request APPROVED (decidedBy/decidedAt); audit `JOIN_REQUEST_APPROVED` |
| **Expected Socket/Event** | RabbitMQ `community.member.added` (via `join_request_approved`)                                                         |
| **Notes**                 | Idempotent if already APPROVED; BANNED target → request REJECTED + `403 COMMUNITY_JOIN_BANNED`.                         |

### TC-COMM-045 — Approve by plain MEMBER forbidden

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                                     |
| **API/Event Name**        | `POST /api/v1/communities/:id/join-requests/:requestId/approve` |
| **Test Scenario**         | Member tries to approve                                         |
| **Category**              | RBAC                                                            |
| **Priority**              | High                                                            |
| **Preconditions**         | Caller MEMBER                                                   |
| **Request Payload**       | —                                                               |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                                     |
| **Expected DB Changes**   | None                                                            |
| **Expected Socket/Event** | None                                                            |
| **Notes**                 | —                                                               |

### TC-COMM-046 — Approve non-PENDING request

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| **Feature/Module**        | Communities / Join requests                |
| **API/Event Name**        | `.../approve`                              |
| **Test Scenario**         | Request already REJECTED/CANCELLED         |
| **Category**              | Business Rule                              |
| **Priority**              | Medium                                     |
| **Preconditions**         | Request terminal (not APPROVED/PENDING)    |
| **Request Payload**       | —                                          |
| **Expected Response**     | `400` `COMMUNITY_JOIN_REQUEST_NOT_PENDING` |
| **Expected DB Changes**   | None                                       |
| **Expected Socket/Event** | None                                       |
| **Notes**                 | —                                          |

### TC-COMM-047 — Reject join request (MODERATOR+)

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                                      |
| **API/Event Name**        | `POST /api/v1/communities/:id/join-requests/:requestId/reject`   |
| **Test Scenario**         | Moderator rejects PENDING                                        |
| **Category**              | Happy Path                                                       |
| **Priority**              | Medium                                                           |
| **Preconditions**         | MODERATOR+; PENDING                                              |
| **Request Payload**       | —                                                                |
| **Expected Response**     | `200` request REJECTED                                           |
| **Expected DB Changes**   | request REJECTED; audit `JOIN_REQUEST_REJECTED`; no member added |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | Non-PENDING → `400`.                                             |

### TC-COMM-048 — Cancel own join request

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                                   |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/join-requests/:requestId`     |
| **Test Scenario**         | Requester cancels their own PENDING request                   |
| **Category**              | Happy Path                                                    |
| **Priority**              | Medium                                                        |
| **Preconditions**         | Caller is request owner; PENDING                              |
| **Request Payload**       | —                                                             |
| **Expected Response**     | `200` request CANCELLED                                       |
| **Expected DB Changes**   | request CANCELLED                                             |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Cancel by non-owner → `403 COMMUNITY_JOIN_REQUEST_NOT_OWNER`. |

### TC-COMM-049 — List community join requests (MODERATOR+)

| Field                     | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                                      |
| **API/Event Name**        | `GET /api/v1/communities/:id/join-requests?status=&page=&limit=` |
| **Test Scenario**         | Moderator lists requests (defaults PENDING)                      |
| **Category**              | RBAC / Pagination                                                |
| **Priority**              | Medium                                                           |
| **Preconditions**         | MODERATOR+                                                       |
| **Request Payload**       | query                                                            |
| **Expected Response**     | `200` paginated requests with embedded user snapshot             |
| **Expected DB Changes**   | None                                                             |
| **Expected Socket/Event** | None                                                             |
| **Notes**                 | status enum PENDING/APPROVED/REJECTED/CANCELLED; limit ≤50.      |

### TC-COMM-050 — List my join requests

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Communities / Join requests                        |
| **API/Event Name**        | `GET /api/v1/communities/join-requests/mine`       |
| **Test Scenario**         | Caller lists their own requests across communities |
| **Category**              | Happy Path                                         |
| **Priority**              | Low                                                |
| **Preconditions**         | Authenticated                                      |
| **Request Payload**       | query page/limit/status                            |
| **Expected Response**     | `200` paginated with embedded community summary    |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |
| **Notes**                 | Static route registered before `/:id`.             |

## 1:1 invites

### TC-COMM-051 — Create invite (MODERATOR+)

| Field                     | Value                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invites                                                                                                                                 |
| **API/Event Name**        | `POST /api/v1/communities/:id/invites`                                                                                                                |
| **Test Scenario**         | Moderator invites a user                                                                                                                              |
| **Category**              | RBAC / Happy Path                                                                                                                                     |
| **Priority**              | Medium                                                                                                                                                |
| **Preconditions**         | MODERATOR+; invitee not a member                                                                                                                      |
| **Request Payload**       | `{ "inviteeId": "<uuid>" }`                                                                                                                           |
| **Expected Response**     | `201` invite DTO PENDING                                                                                                                              |
| **Expected DB Changes**   | invite row PENDING; audit `MEMBER_INVITED`                                                                                                            |
| **Expected Socket/Event** | RabbitMQ `community.invite.sent`                                                                                                                      |
| **Notes**                 | Self-invite → `400 COMMUNITY_MEMBER_CANNOT_MODIFY_SELF`; active member → `409 COMMUNITY_ALREADY_MEMBER`; banned → `403 COMMUNITY_INVITE_USER_BANNED`. |

### TC-COMM-052 — Accept invite

| Field                     | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invites                                                                        |
| **API/Event Name**        | `POST /api/v1/communities/invites/:inviteId/accept`                                          |
| **Test Scenario**         | Invitee accepts a PENDING invite                                                             |
| **Category**              | Happy Path                                                                                   |
| **Priority**              | High                                                                                         |
| **Preconditions**         | Caller is invitee; invite PENDING                                                            |
| **Request Payload**       | —                                                                                            |
| **Expected Response**     | `200` `{ invite: ACCEPTED, member: ACTIVE }`                                                 |
| **Expected DB Changes**   | member ACTIVE (created/reactivated); memberCount++; invite ACCEPTED; audit `INVITE_ACCEPTED` |
| **Expected Socket/Event** | RabbitMQ `community.invite.accepted` (NOT member.added)                                      |
| **Notes**                 | Wrong invitee → `403 COMMUNITY_INVITE_NOT_INVITEE`; banned → `403 COMMUNITY_JOIN_BANNED`.    |

### TC-COMM-053 — Decline invite

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Communities / Invites                                |
| **API/Event Name**        | `POST /api/v1/communities/invites/:inviteId/decline` |
| **Test Scenario**         | Invitee declines                                     |
| **Category**              | Happy Path                                           |
| **Priority**              | Low                                                  |
| **Preconditions**         | Caller invitee; PENDING                              |
| **Request Payload**       | —                                                    |
| **Expected Response**     | `200` invite DECLINED                                |
| **Expected DB Changes**   | invite DECLINED; audit `INVITE_DECLINED`             |
| **Expected Socket/Event** | None                                                 |
| **Notes**                 | Non-PENDING → `400 COMMUNITY_INVITE_NOT_PENDING`.    |

## Invite links (PUBLIC only)

### TC-COMM-054 — Create invite link (MODERATOR+, PUBLIC)

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                                                         |
| **API/Event Name**        | `POST /api/v1/communities/:id/invite-links`                                        |
| **Test Scenario**         | Moderator generates a shareable link                                               |
| **Category**              | Happy Path                                                                         |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | MODERATOR+; PUBLIC community                                                       |
| **Request Payload**       | `{ "maxUses": 10, "expiresInMinutes": 1440, "autoApprove": false }`                |
| **Expected Response**     | `201` link DTO with `code`, `url`, `isActive:true`                                 |
| **Expected DB Changes**   | link row; audit `INVITE_LINK_CREATED`                                              |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | PRIVATE → `403 COMMUNITY_INVITE_LINK_ONLY_FOR_PUBLIC`; code collisions retried 3x. |

### TC-COMM-055 — Redeem invite link (autoApprove=false → join request)

| Field                     | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                                                                     |
| **API/Event Name**        | `POST /api/v1/communities/invite-links/:code/redeem`                                           |
| **Test Scenario**         | New user redeems a non-auto-approve link                                                       |
| **Category**              | Happy Path                                                                                     |
| **Priority**              | High                                                                                           |
| **Preconditions**         | Active link; caller not a member                                                               |
| **Request Payload**       | —                                                                                              |
| **Expected Response**     | `200` `{ link, request: PENDING }`                                                             |
| **Expected DB Changes**   | `usedCount` atomically incremented; audit `INVITE_LINK_REDEEMED`; PENDING join request created |
| **Expected Socket/Event** | RabbitMQ `community.join.requested`                                                            |
| **Notes**                 | —                                                                                              |

### TC-COMM-056 — Redeem invite link (autoApprove=true → instant member)

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                                    |
| **API/Event Name**        | `.../redeem`                                                  |
| **Test Scenario**         | Link with autoApprove adds member directly                    |
| **Category**              | Business Rule                                                 |
| **Priority**              | High                                                          |
| **Preconditions**         | Active autoApprove link                                       |
| **Request Payload**       | —                                                             |
| **Expected Response**     | `200` `{ link, member: ACTIVE }`                              |
| **Expected DB Changes**   | member ACTIVE created/reactivated; memberCount++; usedCount++ |
| **Expected Socket/Event** | (see consumer) — no `/community` socket                       |
| **Notes**                 | —                                                             |

### TC-COMM-057 — Redeem expired / revoked / exhausted link

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Invite links                                                     |
| **API/Event Name**        | `.../redeem`                                                                   |
| **Test Scenario**         | Link past expiry, revoked, or at maxUses                                       |
| **Category**              | Error Handling                                                                 |
| **Priority**              | High                                                                           |
| **Preconditions**         | One of: revokedAt set / expiresAt past / usedCount≥maxUses                     |
| **Request Payload**       | —                                                                              |
| **Expected Response**     | `410` `COMMUNITY_INVITE_LINK_REVOKED_ERROR` / `_EXPIRED` / `_EXHAUSTED`        |
| **Expected DB Changes**   | None                                                                           |
| **Expected Socket/Event** | None                                                                           |
| **Notes**                 | Bad code → `404 COMMUNITY_INVITE_LINK_NOT_FOUND`; invalid code format → `400`. |

### TC-COMM-058 — Redeem race past maxUses (capacity guard)

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                                              |
| **API/Event Name**        | `.../redeem`                                                            |
| **Test Scenario**         | Two users redeem the last remaining use simultaneously                  |
| **Category**              | Concurrency                                                             |
| **Priority**              | Medium                                                                  |
| **Preconditions**         | maxUses with 1 remaining                                                |
| **Request Payload**       | —                                                                       |
| **Expected Response**     | One `200`, the loser `410` `COMMUNITY_INVITE_LINK_EXHAUSTED`            |
| **Expected DB Changes**   | usedCount never exceeds maxUses                                         |
| **Expected Socket/Event** | winner events only                                                      |
| **Notes**                 | `incrementInviteLinkUsageIfUnder` atomic guard (count===0 → exhausted). |

### TC-COMM-059 — Redeem when already ACTIVE member (idempotent)

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                   |
| **API/Event Name**        | `.../redeem`                                 |
| **Test Scenario**         | Existing member redeems link                 |
| **Category**              | Idempotency                                  |
| **Priority**              | Low                                          |
| **Preconditions**         | Caller ACTIVE member                         |
| **Request Payload**       | —                                            |
| **Expected Response**     | `200` `{ link, member }`                     |
| **Expected DB Changes**   | usedCount NOT incremented; no re-add         |
| **Expected Socket/Event** | None                                         |
| **Notes**                 | Banned member → `403 COMMUNITY_JOIN_BANNED`. |

### TC-COMM-060 — Revoke invite link (MODERATOR+)

| Field                     | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Invite links                                                   |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/invite-links/:linkId`                        |
| **Test Scenario**         | Moderator revokes a link                                                     |
| **Category**              | RBAC                                                                         |
| **Priority**              | Medium                                                                       |
| **Preconditions**         | MODERATOR+; link belongs to community                                        |
| **Request Payload**       | —                                                                            |
| **Expected Response**     | `200` link with `revokedAt` set, `isActive:false`                            |
| **Expected DB Changes**   | revokedAt set; audit `INVITE_LINK_REVOKED`; idempotent if already revoked    |
| **Expected Socket/Event** | None                                                                         |
| **Notes**                 | Cross-community linkId → `404 COMMUNITY_INVITE_LINK_NOT_FOUND` (IDOR guard). |

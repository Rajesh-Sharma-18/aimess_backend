# Communities — Moderation (kick / ban / mute / warn / reports)

**Source:** `apps/community-service/src/api/routes/community.routes.ts` (`DELETE /:id/members/:userId`, `POST|DELETE /:id/members/:userId/ban`, `.../mute`, `.../warn`, `/:id/muted-members`, `/:id/members/:userId/warnings`, reports routes), `services/community.service.ts` (`kickMember`, `banMember`, `unbanMember`, `muteMember`, `unmuteMember`, `warnMember`, reports `_resolveReport`/withdraw/delete), `lib/community-authz.ts` (`_assertCanModerateMember`).

> **Service:** community-service. Kick/Mute/Warn = **MODERATOR+** with strict-rank rule (caller must outrank target; ADMIN target always blocked). Ban/Unban = **ADMIN-only**. Reports: any ACTIVE member files; MODERATOR+ resolve.

---

## Kick

### TC-COMM-078 — Kick member (MODERATOR+)

| Field                     | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                                     |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId`             |
| **Test Scenario**         | Moderator kicks a member                                     |
| **Category**              | RBAC / Happy Path                                            |
| **Priority**              | High                                                         |
| **Preconditions**         | Caller MODERATOR+; target ACTIVE MEMBER (lower rank)         |
| **Request Payload**       | `{ "reason": "spam" }` (optional, ≤500)                      |
| **Expected Response**     | `200` member DTO status LEFT                                 |
| **Expected DB Changes**   | member → LEFT; memberCount recomputed; audit `MEMBER_KICKED` |
| **Expected Socket/Event** | RabbitMQ `community.member.kicked`                           |
| **Notes**                 | Kick = LEFT (re-joinable), not BANNED.                       |

### TC-COMM-079 — Moderator cannot kick peer MODERATOR

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                                                             |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId`                                     |
| **Test Scenario**         | Moderator targets another moderator                                                  |
| **Category**              | RBAC / Security                                                                      |
| **Priority**              | High                                                                                 |
| **Preconditions**         | Caller MODERATOR; target MODERATOR                                                   |
| **Request Payload**       | `{}`                                                                                 |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                                                          |
| **Expected DB Changes**   | None                                                                                 |
| **Expected Socket/Event** | None                                                                                 |
| **Notes**                 | Strict rank: `RANK[caller] <= RANK[target]` → forbidden. ADMIN can kick a moderator. |

### TC-COMM-080 — Kick self rejected

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                         |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId` |
| **Test Scenario**         | userId == caller                                 |
| **Category**              | Business Rule                                    |
| **Priority**              | Medium                                           |
| **Preconditions**         | MODERATOR+                                       |
| **Request Payload**       | `{}`                                             |
| **Expected Response**     | `400` `COMMUNITY_MEMBER_CANNOT_MODIFY_SELF`      |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | Use leave instead.                               |

### TC-COMM-081 — Kick the ADMIN rejected

| Field                     | Value                                            |
| ------------------------- | ------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                         |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId` |
| **Test Scenario**         | Target is admin                                  |
| **Category**              | Business Rule                                    |
| **Priority**              | High                                             |
| **Preconditions**         | Target adminId/role ADMIN                        |
| **Request Payload**       | `{}`                                             |
| **Expected Response**     | `400` `COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN`     |
| **Expected DB Changes**   | None                                             |
| **Expected Socket/Event** | None                                             |
| **Notes**                 | —                                                |

## Ban / Unban (ADMIN-only)

### TC-COMM-082 — Ban member (ADMIN)

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                                                             |
| **API/Event Name**        | `POST /api/v1/communities/:id/members/:userId/ban`                                   |
| **Test Scenario**         | Admin bans a member                                                                  |
| **Category**              | RBAC / Happy Path                                                                    |
| **Priority**              | High                                                                                 |
| **Preconditions**         | Caller ADMIN; target not admin                                                       |
| **Request Payload**       | `{ "reason": "abuse" }`                                                              |
| **Expected Response**     | `200` member DTO status BANNED with bannedAt/bannedBy/banReason                      |
| **Expected DB Changes**   | member → BANNED; memberCount recomputed; audit `MEMBER_BANNED`                       |
| **Expected Socket/Event** | RabbitMQ `community.member.banned`                                                   |
| **Notes**                 | Idempotent if already BANNED (no write). Ban allows non-ACTIVE target (unlike kick). |

### TC-COMM-083 — Ban by MODERATOR forbidden

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                      |
| **API/Event Name**        | `POST /api/v1/communities/:id/members/:userId/ban`            |
| **Test Scenario**         | Moderator attempts ban                                        |
| **Category**              | RBAC                                                          |
| **Priority**              | High                                                          |
| **Preconditions**         | Caller MODERATOR                                              |
| **Request Payload**       | `{}`                                                          |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`                                   |
| **Expected DB Changes**   | None                                                          |
| **Expected Socket/Event** | None                                                          |
| **Notes**                 | Ban requires ADMIN (does not use `_assertCanModerateMember`). |

### TC-COMM-084 — Unban member (ADMIN) → LEFT

| Field                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                                           |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId/ban`                               |
| **Test Scenario**         | Admin lifts a ban                                                                  |
| **Category**              | Happy Path                                                                         |
| **Priority**              | Medium                                                                             |
| **Preconditions**         | Caller ADMIN; target BANNED                                                        |
| **Request Payload**       | —                                                                                  |
| **Expected Response**     | `200` member status LEFT (not auto re-added)                                       |
| **Expected DB Changes**   | status → LEFT; ban fields cleared; memberCount recomputed; audit `MEMBER_UNBANNED` |
| **Expected Socket/Event** | None                                                                               |
| **Notes**                 | Not currently BANNED → `400 COMMUNITY_MEMBER_NOT_BANNED`.                          |

## Member mute (moderation mute, distinct from notification mute)

### TC-COMM-085 — Mute member with duration (MODERATOR+)

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                 |
| **API/Event Name**        | `POST /api/v1/communities/:id/members/:userId/mute`      |
| **Test Scenario**         | Moderator mutes a member for N minutes                   |
| **Category**              | RBAC / Happy Path                                        |
| **Priority**              | High                                                     |
| **Preconditions**         | Caller MODERATOR+ outranks target                        |
| **Request Payload**       | `{ "durationMinutes": 60, "reason": "spam" }` (1–525600) |
| **Expected Response**     | `200` muted-member DTO with `mutedUntil`                 |
| **Expected DB Changes**   | member-mute upsert; audit `MEMBER_MUTED`                 |
| **Expected Socket/Event** | RabbitMQ `community.member.muted`                        |
| **Notes**                 | null/omitted duration → indefinite mute.                 |

### TC-COMM-086 — Unmute member (MODERATOR+)

| Field                     | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                        |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/members/:userId/mute`           |
| **Test Scenario**         | Moderator removes a mute                                        |
| **Category**              | Happy Path                                                      |
| **Priority**              | Medium                                                          |
| **Preconditions**         | Active mute exists                                              |
| **Request Payload**       | —                                                               |
| **Expected Response**     | `200` (data null)                                               |
| **Expected DB Changes**   | member-mute deleted; audit `MEMBER_UNMUTED`                     |
| **Expected Socket/Event** | RabbitMQ `community.member.unmuted`                             |
| **Notes**                 | No active mute (or expired) → `404 COMMUNITY_MEMBER_NOT_MUTED`. |

### TC-COMM-087 — List muted members (MODERATOR+)

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                 |
| **API/Event Name**        | `GET /api/v1/communities/:id/muted-members?page=&limit=` |
| **Test Scenario**         | Moderator lists currently muted members                  |
| **Category**              | RBAC / Pagination                                        |
| **Priority**              | Low                                                      |
| **Preconditions**         | MODERATOR+                                               |
| **Request Payload**       | query                                                    |
| **Expected Response**     | `200` paginated (excludes expired); snapshot + avatar    |
| **Expected DB Changes**   | None                                                     |
| **Expected Socket/Event** | None                                                     |
| **Notes**                 | —                                                        |

### TC-COMM-088 — Mute member duration out of range

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                            |
| **API/Event Name**        | `POST /api/v1/communities/:id/members/:userId/mute` |
| **Test Scenario**         | durationMinutes = 0 or > 525600                     |
| **Category**              | Input Validation                                    |
| **Priority**              | Low                                                 |
| **Preconditions**         | MODERATOR+                                          |
| **Request Payload**       | `{ "durationMinutes": 0 }`                          |
| **Expected Response**     | `400`                                               |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |
| **Notes**                 | min 1, max 525600 (365 days).                       |

## Warnings

### TC-COMM-089 — Warn member (MODERATOR+)

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| **Feature/Module**        | Communities / Moderation                               |
| **API/Event Name**        | `POST /api/v1/communities/:id/members/:userId/warn`    |
| **Test Scenario**         | Moderator records a warning note                       |
| **Category**              | RBAC / Happy Path                                      |
| **Priority**              | Medium                                                 |
| **Preconditions**         | MODERATOR+ outranks target                             |
| **Request Payload**       | `{ "note": "Please follow rules" }` (1–1000, required) |
| **Expected Response**     | `201` warning DTO                                      |
| **Expected DB Changes**   | warning row; audit `MEMBER_WARNED`                     |
| **Expected Socket/Event** | RabbitMQ `community.member.warned`                     |
| **Notes**                 | Empty note → `400`.                                    |

### TC-COMM-090 — List member warnings (MODERATOR+)

| Field                     | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Moderation                                            |
| **API/Event Name**        | `GET /api/v1/communities/:id/members/:userId/warnings?page=&limit=` |
| **Test Scenario**         | Moderator reviews a member's warnings                               |
| **Category**              | RBAC / Pagination                                                   |
| **Priority**              | Low                                                                 |
| **Preconditions**         | MODERATOR+                                                          |
| **Request Payload**       | query                                                               |
| **Expected Response**     | `200` paginated warnings                                            |
| **Expected DB Changes**   | None                                                                |
| **Expected Socket/Event** | None                                                                |
| **Notes**                 | MEMBER/non-member → `403`.                                          |

## Reports

### TC-COMM-091 — Create report (ACTIVE member)

| Field                     | Value                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                                                                                                                   |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports`                                                                                                                  |
| **Test Scenario**         | Member reports another member                                                                                                                           |
| **Category**              | Happy Path                                                                                                                                              |
| **Priority**              | High                                                                                                                                                    |
| **Preconditions**         | Caller ACTIVE member; targetUserId is a member                                                                                                          |
| **Request Payload**       | `{ "targetUserId": "<uuid>", "reason": "harassment" }` (reason 3–1000)                                                                                  |
| **Expected Response**     | `201` report DTO OPEN                                                                                                                                   |
| **Expected DB Changes**   | report OPEN row                                                                                                                                         |
| **Expected Socket/Event** | RabbitMQ `community.report.created` to ADMIN+MODERATOR                                                                                                  |
| **Notes**                 | targetUserId optional (community-level report). Self-report → `400 COMMUNITY_REPORT_CANNOT_TARGET_SELF`. Duplicate OPEN report → returned idempotently. |

### TC-COMM-092 — Create report by non-member forbidden

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| **Feature/Module**        | Communities / Reports                  |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports` |
| **Test Scenario**         | Outsider files a report                |
| **Category**              | RBAC / Security                        |
| **Priority**              | High                                   |
| **Preconditions**         | Caller not ACTIVE member               |
| **Request Payload**       | `{ "reason": "spam" }`                 |
| **Expected Response**     | `403` `COMMUNITY_FORBIDDEN`            |
| **Expected DB Changes**   | None                                   |
| **Expected Socket/Event** | None                                   |
| **Notes**                 | —                                      |

### TC-COMM-093 — Report a target who is not a member

| Field                     | Value                                             |
| ------------------------- | ------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                             |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports`            |
| **Test Scenario**         | targetUserId is not a member row                  |
| **Category**              | Error Handling                                    |
| **Priority**              | Medium                                            |
| **Preconditions**         | targetUserId has no member row                    |
| **Request Payload**       | `{ "targetUserId": "<stranger>", "reason": "x" }` |
| **Expected Response**     | `404` `COMMUNITY_MEMBER_NOT_FOUND`                |
| **Expected DB Changes**   | None                                              |
| **Expected Socket/Event** | None                                              |
| **Notes**                 | Member row of any status accepted.                |

### TC-COMM-094 — Review / Action / Dismiss report (MODERATOR+)

| Field                     | Value                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                                                                                                                                       |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports/:reportId/{review,action,dismiss}`                                                                                                    |
| **Test Scenario**         | Moderator transitions a report                                                                                                                                              |
| **Category**              | RBAC / Business Rule                                                                                                                                                        |
| **Priority**              | High                                                                                                                                                                        |
| **Preconditions**         | MODERATOR+; report in a valid source state                                                                                                                                  |
| **Request Payload**       | `{ "resolution": "handled" }` (optional, ≤1000)                                                                                                                             |
| **Expected Response**     | `200` updated report (REVIEWED/ACTIONED/DISMISSED)                                                                                                                          |
| **Expected DB Changes**   | status transition; reviewedBy/reviewedAt/resolution; audit per action                                                                                                       |
| **Expected Socket/Event** | RabbitMQ `community.report.actioned` ONLY on ACTIONED (review/dismiss do not publish)                                                                                       |
| **Notes**                 | Transitions: OPEN→{REVIEWED,ACTIONED,DISMISSED}; REVIEWED→{ACTIONED,DISMISSED}; ACTIONED/DISMISSED/WITHDRAWN terminal. Invalid → `400 COMMUNITY_REPORT_INVALID_TRANSITION`. |

### TC-COMM-095 — Withdraw own report (reporter, OPEN-only)

| Field                     | Value                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                                                                                                    |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports/:reportId/withdraw`                                                                                |
| **Test Scenario**         | Reporter withdraws their own OPEN report                                                                                                 |
| **Category**              | Business Rule                                                                                                                            |
| **Priority**              | Medium                                                                                                                                   |
| **Preconditions**         | Caller is reporter; report OPEN                                                                                                          |
| **Request Payload**       | —                                                                                                                                        |
| **Expected Response**     | `200` report WITHDRAWN (resolution `withdrawn_by_reporter`)                                                                              |
| **Expected DB Changes**   | status WITHDRAWN; no audit                                                                                                               |
| **Expected Socket/Event** | None                                                                                                                                     |
| **Notes**                 | Non-owner → `403 COMMUNITY_REPORT_NOT_OWNER`; non-OPEN → `400 COMMUNITY_REPORT_NOT_OPEN`. No mod authz. Works even on deleted community. |

### TC-COMM-096 — Delete report (MODERATOR+ hard delete)

| Field                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                          |
| **API/Event Name**        | `DELETE /api/v1/communities/:id/reports/:reportId`             |
| **Test Scenario**         | Moderator hard-deletes a report                                |
| **Category**              | RBAC                                                           |
| **Priority**              | Low                                                            |
| **Preconditions**         | MODERATOR+; report belongs to community                        |
| **Request Payload**       | —                                                              |
| **Expected Response**     | `200` `COMMUNITY_REPORT_DELETED`                               |
| **Expected DB Changes**   | report removed; audit `COMMUNITY_REPORT_DELETED` (priorStatus) |
| **Expected Socket/Event** | None                                                           |
| **Notes**                 | Cross-community reportId → `404` (IDOR guard).                 |

### TC-COMM-097 — List community reports (MODERATOR+) / my reports

| Field                     | Value                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                                                             |
| **API/Event Name**        | `GET /api/v1/communities/:id/reports` · `GET /api/v1/communities/reports/mine`                    |
| **Test Scenario**         | Mod lists community reports (default OPEN); reporter lists own                                    |
| **Category**              | RBAC / Pagination                                                                                 |
| **Priority**              | Medium                                                                                            |
| **Preconditions**         | MODERATOR+ for `:id/reports`; any auth for `/mine`                                                |
| **Request Payload**       | query page/limit/status                                                                           |
| **Expected Response**     | `200` paginated; `:id/reports` embeds reporter+target snapshots; `/mine` embeds community summary |
| **Expected DB Changes**   | None                                                                                              |
| **Expected Socket/Event** | None                                                                                              |
| **Notes**                 | `:id/reports` by MEMBER → `403`. status enum OPEN/REVIEWED/ACTIONED/DISMISSED/WITHDRAWN.          |

### TC-COMM-098 — IDOR: act on report from another community

| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| **Feature/Module**        | Communities / Reports                                      |
| **API/Event Name**        | `POST /api/v1/communities/:id/reports/:reportId/action`    |
| **Test Scenario**         | reportId belongs to a different community than `:id`       |
| **Category**              | Security                                                   |
| **Priority**              | High                                                       |
| **Preconditions**         | Caller MODERATOR in community A; reportId from community B |
| **Request Payload**       | `{}`                                                       |
| **Expected Response**     | `404` `COMMUNITY_REPORT_NOT_FOUND`                         |
| **Expected DB Changes**   | None                                                       |
| **Expected Socket/Event** | None                                                       |
| **Notes**                 | All report handlers verify `report.communityId === :id`.   |

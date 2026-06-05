# Communities — Channels (GAP ANALYSIS)

**Source searched:** `apps/community-service/src/api/routes/community.routes.ts`, `apps/chat-service/src/api/routes/community.routes.ts`, controllers, validators, services, repositories, Prisma generated client.

> **Status: NOT IMPLEMENTED.** There are **no channel endpoints** in either service. Neither community-service nor chat-service exposes create/update/delete channel, channel types, or a "default channel" concept. A community maps to **exactly one chat room** (chat-service `GeneralRoom`, id === community.id), provisioned on community creation via `publishCommunityCreatedForChatSafe`.

## What exists instead of channels

- **community-service** owns: communities, members/roles, join-requests, invites, invite-links, reports, mute, notification preferences, audit logs, categories.
- **chat-service** owns: the single community chat room (`GeneralRoom`) and its messages (see `community-chat.md`). "Rooms" here are 1 room per community, not multiple channels.

## Implication for the test repository

The brief mentions "channels (create/update/delete, channel types), … can't delete default channel". **None of this is shippable behavior today** — there is no model, route, controller, validator, or service for channels. The following are placeholders documenting the gap so the matrix stays honest. Mark all as **N/A — not implemented**.

---

### TC-COMM-114 — Create channel (NOT IMPLEMENTED)

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Channels                                                                                           |
| **API/Event Name**        | (none — no route)                                                                                                |
| **Test Scenario**         | Create a channel within a community                                                                              |
| **Category**              | Gap                                                                                                              |
| **Priority**              | N/A                                                                                                              |
| **Preconditions**         | —                                                                                                                |
| **Request Payload**       | —                                                                                                                |
| **Expected Response**     | No endpoint exists. Calling any `/channels` path → `404` route-not-found from the gateway.                       |
| **Expected DB Changes**   | None                                                                                                             |
| **Expected Socket/Event** | None                                                                                                             |
| **Notes**                 | A community has one implicit room (GeneralRoom). Channel CRUD would need a new model + routes. Flag for product. |

### TC-COMM-115 — Update / Delete channel & channel types (NOT IMPLEMENTED)

| Field                     | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Channels                                                     |
| **API/Event Name**        | (none)                                                                     |
| **Test Scenario**         | Update channel, delete channel, set channel type (text/voice/announcement) |
| **Category**              | Gap                                                                        |
| **Priority**              | N/A                                                                        |
| **Preconditions**         | —                                                                          |
| **Request Payload**       | —                                                                          |
| **Expected Response**     | Not implemented                                                            |
| **Expected DB Changes**   | None                                                                       |
| **Expected Socket/Event** | None                                                                       |
| **Notes**                 | No "channel type" enum exists in the Prisma schema.                        |

### TC-COMM-116 — Cannot delete default channel (NOT IMPLEMENTED)

| Field                     | Value                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Communities / Channels                                                                                                        |
| **API/Event Name**        | (none)                                                                                                                        |
| **Test Scenario**         | Business rule: default channel is undeletable                                                                                 |
| **Category**              | Gap                                                                                                                           |
| **Priority**              | N/A                                                                                                                           |
| **Preconditions**         | —                                                                                                                             |
| **Request Payload**       | —                                                                                                                             |
| **Expected Response**     | Not implemented — no channel concept, hence no "default channel" rule                                                         |
| **Expected DB Changes**   | None                                                                                                                          |
| **Expected Socket/Event** | None                                                                                                                          |
| **Notes**                 | The closest analog is the single GeneralRoom, which is created/torn down with the community lifecycle, not via a channel API. |

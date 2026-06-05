# FRIENDS — Reject (Decline) & Cancel Friend Request

**Source:**

- `apps/user-service/src/api/routes/friendship.routes.ts` (`POST /requests/:id/reject`, `DELETE /requests/:id`)
- `apps/user-service/src/api/controllers/friendship.controller.ts` (`rejectFriendRequest`, `cancelFriendRequest`)
- `apps/user-service/src/services/friendship.service.ts` (`rejectRequest`, `cancelRequest`)
- `apps/user-service/src/repositories/friendship.repository.ts` (`findById`, `reject`, `cancel`)

**External paths:**

- Reject (addressee declines): `POST /api/v1/users/friends/requests/:id/reject`
- Cancel (requester withdraws): `DELETE /api/v1/users/friends/requests/:id`

> Rules:
>
> - **Reject** allowed only by the **addressee** of a PENDING request → `status=REJECTED`, `rejectedAt` set.
> - **Cancel** allowed only by the **requester** of a PENDING request → `status=CANCELLED`, `cancelledAt` set.
> - Neither path emits a RabbitMQ event, invalidates cache, or touches `friendsCount`.
> - Authz/state failures all collapse to `404 FRIEND_REQUEST_NOT_FOUND`.

---

### TC-FRND-030 — Addressee rejects a pending request

| Field                     | Value                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Reject Request                                                                      |
| **API/Event Name**        | `POST /api/v1/users/friends/requests/:id/reject`                                              |
| **Test Scenario**         | Addressee declines a PENDING request                                                          |
| **Category**              | Happy Path                                                                                    |
| **Priority**              | High                                                                                          |
| **Preconditions**         | Row `addresseeId=me, status=PENDING`                                                          |
| **Request Payload**       | `:id`; empty body                                                                             |
| **Expected Response**     | `200` `{ data: { status: "REJECTED", rejectedAt: <ts> } }`, message `FRIEND_REQUEST_REJECTED` |
| **Expected DB Changes**   | Row → `status=REJECTED`, `rejectedAt` set; `friendsCount` unchanged                           |
| **Expected Socket/Event** | None (no publish)                                                                             |
| **Notes**                 | Row retained for future re-friend via `resetToPending`                                        |

### TC-FRND-031 — Requester cancels own pending request

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Feature/Module**        | Friends / Cancel Request                                                                         |
| **API/Event Name**        | `DELETE /api/v1/users/friends/requests/:id`                                                      |
| **Test Scenario**         | Requester withdraws their PENDING outgoing request                                               |
| **Category**              | Happy Path                                                                                       |
| **Priority**              | High                                                                                             |
| **Preconditions**         | Row `requesterId=me, status=PENDING`                                                             |
| **Request Payload**       | `:id`                                                                                            |
| **Expected Response**     | `200` `{ data: { status: "CANCELLED", cancelledAt: <ts> } }`, message `FRIEND_REQUEST_CANCELLED` |
| **Expected DB Changes**   | Row → `status=CANCELLED`, `cancelledAt` set                                                      |
| **Expected Socket/Event** | None                                                                                             |

### TC-FRND-032 — Requester tries to reject (wrong side)

| Field                     | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Reject Request                                                |
| **API/Event Name**        | `POST .../requests/:id/reject`                                          |
| **Test Scenario**         | Requester calls reject on their own request (only addressee may reject) |
| **Category**              | AuthZ / Security                                                        |
| **Priority**              | High                                                                    |
| **Preconditions**         | Row `requesterId=me, status=PENDING`                                    |
| **Request Payload**       | `:id`                                                                   |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                                        |
| **Expected DB Changes**   | None                                                                    |
| **Expected Socket/Event** | None                                                                    |

### TC-FRND-033 — Addressee tries to cancel (wrong side)

| Field                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| **Feature/Module**        | Friends / Cancel Request                           |
| **API/Event Name**        | `DELETE .../requests/:id`                          |
| **Test Scenario**         | Addressee calls cancel (only requester may cancel) |
| **Category**              | AuthZ / Security                                   |
| **Priority**              | High                                               |
| **Preconditions**         | Row `addresseeId=me, status=PENDING`               |
| **Request Payload**       | `:id`                                              |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                   |
| **Expected DB Changes**   | None                                               |
| **Expected Socket/Event** | None                                               |

### TC-FRND-034 — Third party rejects/cancels (IDOR)

| Field                     | Value                                               |
| ------------------------- | --------------------------------------------------- |
| **Feature/Module**        | Friends / Reject & Cancel                           |
| **API/Event Name**        | `POST .../reject` & `DELETE .../requests/:id`       |
| **Test Scenario**         | User C acts on an A→B request                       |
| **Category**              | Security                                            |
| **Priority**              | High                                                |
| **Preconditions**         | Row A→B PENDING; caller=C                           |
| **Request Payload**       | `:id` of A→B                                        |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND` for both endpoints |
| **Expected DB Changes**   | None                                                |
| **Expected Socket/Event** | None                                                |

### TC-FRND-035 — Reject a non-PENDING request

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| **Feature/Module**        | Friends / Reject Request                             |
| **API/Event Name**        | `POST .../reject`                                    |
| **Test Scenario**         | Reject on ACCEPTED/REJECTED/CANCELLED/UNFRIENDED row |
| **Category**              | DB State                                             |
| **Priority**              | Medium                                               |
| **Preconditions**         | Row not PENDING                                      |
| **Request Payload**       | `:id`                                                |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`                     |
| **Expected DB Changes**   | None                                                 |
| **Expected Socket/Event** | None                                                 |

### TC-FRND-036 — Cancel a non-PENDING request

| Field                     | Value                                    |
| ------------------------- | ---------------------------------------- |
| **Feature/Module**        | Friends / Cancel Request                 |
| **API/Event Name**        | `DELETE .../requests/:id`                |
| **Test Scenario**         | Cancel on already ACCEPTED/CANCELLED row |
| **Category**              | DB State                                 |
| **Priority**              | Medium                                   |
| **Preconditions**         | Row not PENDING                          |
| **Request Payload**       | `:id`                                    |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`         |
| **Expected DB Changes**   | None                                     |
| **Expected Socket/Event** | None                                     |

### TC-FRND-037 — Reject/Cancel with non-existent id

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Friends / Reject & Cancel                    |
| **API/Event Name**        | `POST .../reject`, `DELETE .../requests/:id` |
| **Test Scenario**         | Valid UUID, no matching row                  |
| **Category**              | Error Handling                               |
| **Priority**              | Medium                                       |
| **Preconditions**         | No such row                                  |
| **Request Payload**       | `:id = <random uuid>`                        |
| **Expected Response**     | `404` `FRIEND_REQUEST_NOT_FOUND`             |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |

### TC-FRND-038 — Reject/Cancel with malformed id

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Friends / Reject & Cancel                    |
| **API/Event Name**        | `POST .../reject`, `DELETE .../requests/:id` |
| **Test Scenario**         | `:id` not a UUID                             |
| **Category**              | Input Validation                             |
| **Priority**              | Medium                                       |
| **Preconditions**         | Authenticated                                |
| **Request Payload**       | `:id = xyz`                                  |
| **Expected Response**     | `400` "Invalid friendship ID"                |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |

### TC-FRND-039 — Reject/Cancel unauthenticated

| Field                     | Value                                        |
| ------------------------- | -------------------------------------------- |
| **Feature/Module**        | Friends / Reject & Cancel                    |
| **API/Event Name**        | `POST .../reject`, `DELETE .../requests/:id` |
| **Test Scenario**         | No token                                     |
| **Category**              | AuthN                                        |
| **Priority**              | High                                         |
| **Preconditions**         | None                                         |
| **Request Payload**       | `:id`                                        |
| **Expected Response**     | `401`                                        |
| **Expected DB Changes**   | None                                         |
| **Expected Socket/Event** | None                                         |

### TC-FRND-040 — Route disambiguation: DELETE `/requests/:id` vs DELETE `/:userId`

| Field                     | Value                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature/Module**        | Friends / Cancel vs Unfriend routing                                                                                                          |
| **API/Event Name**        | `DELETE /api/v1/users/friends/requests/:id`                                                                                                   |
| **Test Scenario**         | Ensure `DELETE /friends/requests/<uuid>` routes to cancel, not unfriend (`/:userId` matches `requests` literal would shadow if ordered wrong) |
| **Category**              | Edge Case                                                                                                                                     |
| **Priority**              | Medium                                                                                                                                        |
| **Preconditions**         | Row PENDING `requesterId=me`                                                                                                                  |
| **Request Payload**       | `DELETE /friends/requests/<id>`                                                                                                               |
| **Expected Response**     | `200` `FRIEND_REQUEST_CANCELLED` (cancel handler, not unfriend)                                                                               |
| **Expected DB Changes**   | `status=CANCELLED`                                                                                                                            |
| **Expected Socket/Event** | None                                                                                                                                          |
| **Notes**                 | `/requests/:id` is registered before `/:userId`, so `requests` is matched as a literal segment first. Regression guard                        |

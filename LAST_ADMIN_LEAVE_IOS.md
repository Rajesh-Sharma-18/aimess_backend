# Last admin leaves a group or community: iOS implementation guide

Status: the backend and website are **implemented and verified live** on the dev stack (2026-10-05). This document covers everything iOS needs to match them. Old app builds keep working with no change; the changes below fix the wrong "Assign an admin" dialog and add the new copy. It follows the app's UIKit + MVVM-C + Combine structure: no SwiftUI and no new storyboards.

---

## 1. What the product does now

When the **admin** leaves and **no other ACTIVE member remains**, the app must not ask them to assign an admin, because there is nobody to assign.

| Entity | State | Who leaves | Other ACTIVE members | Result |
|---|---|---|---|---|
| Group | Active | Admin | 0 | Confirm "Leave & Close Group". The group is closed (disbanded) and the admin leaves. |
| Community | Active | Admin | 0 | Confirm "Leave & Close Community". The community is closed and the admin leaves. |
| Group | Closed by Super Admin | Admin | 0 | Normal leave confirm. The admin leaves and the group stays closed. |
| Community | Closed by Super Admin, or owner-closed | Admin | 0 | Normal leave confirm. The admin leaves and the community stays closed. |
| Group or Community | Active | Admin | 1 or more | **Unchanged**: Assign Admin / transfer first. |
| Community | Closed by Super Admin | Admin | 1 or more | **Unchanged**: transfer first. Super Admin can reopen it, so ownership still matters. |
| Community | Owner-closed | Admin | 1 or more | **Unchanged**: the admin may leave like a member. |
| Group | Closed by Super Admin | Admin | 1 or more | **Unchanged**: `CHAT_OWNER_CANNOT_LEAVE`. |
| Any | Any | Member or Moderator | any | **Unchanged**: normal leave. |

**What counts as "another member":** only rows with status `ACTIVE`. These never count: BANNED, LEFT, KICKED, pending join requests, and outstanding invites. A Moderator is an ACTIVE member, so an admin plus a moderator means a transfer is required.

**"Close" is not "Delete".** History, media, pinned messages and files all stay. Other effects:
- Live streams are force-ended.
- Pending join requests become EXPIRED, and the requester is notified.
- Invite links stop admitting anyone.
- A community closed this way can **never be reopened**: `POST /communities/:id/reopen` returns `403 COMMUNITY_FORBIDDEN`.

---

## 2. Backend contract (what iOS talks to)

### 2.1 Community

**Read state before choosing the dialog** (already used by the app):

```
GET /api/v1/communities/{communityId}
→ data.role            "ADMIN" | "MODERATOR" | "MEMBER" | null
→ data.memberCount     Int      // live ACTIVE count (0 once closed this way)
→ data.status          "ACTIVE" | "CLOSED" | "CLOSED_BY_SYSTEM_BAN"
→ data.closedReasonCode  null | "ADMIN_BANNED" | "LAST_MEMBER_LEFT"
```

`status` already folds the Super Admin close into `"CLOSED"`, so one field answers "is it closed?".

**Leave (single):**

```
POST /api/v1/communities/{communityId}/leave
body: {}                                  // admin: no reason
body: { "reason": "...", "reasonText": "..." }   // member: unchanged
```

| Situation | HTTP | Body |
|---|---|---|
| Admin was the last member of an ACTIVE community (it closes) | 200 | `{ success: true, data: { …member, status: "LEFT" } }`, the same shape as before |
| Admin was the last member of a closed community | 200 | same |
| Admin, others still ACTIVE | 400 | `code: "COMMUNITY_ADMIN_CANNOT_LEAVE"` (unchanged) |
| Membership already ended (retry or double tap) | 404 | `code: "COMMUNITY_MEMBER_NOT_FOUND"`. **Treat this as success.** |

**Leave (bulk, multi-select):** `POST /api/v1/communities/leave/bulk { communityIds: [...] }`

- For the sole-admin case each item now returns `status: "LEFT"`. It used to return `"DELETED"`, and `DELETED` is no longer produced by this path.
- `FAILED / ADMIN_CANNOT_LEAVE` is unchanged.
- Treat `LEFT`, `DELETED`, `NOT_MEMBER` and `NOT_FOUND` as "gone from my list".

### 2.2 Group

**Read the live roster before choosing the dialog.** Do not use the room's stored `memberCount`. It drifts, and that drift is the root cause of the "Assign an admin" bug.

```
GET /api/v1/chat/group-members/{roomId}?limit=2
→ data.data: [ …ACTIVE members… ]   // 1 row ⇒ the caller is alone
```

**Leave:** either endpoint, unchanged shapes.

```
POST /api/v1/chat/group-members/{roomId}/leave          body: { "reason"?: String }
POST /api/v1/chat/conversations/leave/bulk              body: { roomIds: [...], groupAction: "LEAVE" }
```

| Situation | Single endpoint | Bulk item |
|---|---|---|
| Admin, last member, ACTIVE group (it closes) | 200 | `status: "LEFT"` |
| Admin, last member, group CLOSED by Super Admin | 200, the group stays CLOSED | see the note below |
| Admin, others still ACTIVE | 400 `CHAT_OWNER_CANNOT_LEAVE` | `FAILED / OWNER_CANNOT_LEAVE` |
| Already left (retry or double tap) | 404 `CHAT_NOT_A_MEMBER`. **Treat as success.** | `FAILED / NOT_MEMBER`. **Treat as gone.** |

> **Note: closed groups and bulk.** A separate backend change still in progress makes bulk leave of a group CLOSED by Super Admin a per-user **dismiss** (`status: "DELETED"`; the row leaves your list, nothing else changes). Both outcomes remove the row, so a client that drops the row on any non-`FAILED` status handles either one.

### 2.3 Realtime events (all existing; no new event names)

**Community, the last admin leaves an ACTIVE community.** These arrive on the leaver's personal channel, on every one of their devices, in this order:

1. `community:closed` → `{ communityId, status: "CLOSED", closedAt, reason: "LAST_MEMBER_LEFT" }`
2. `community:membership:removed` → `{ communityId, membershipStatus: "REMOVED", reason: "left", removedAt }`

Room channel events, if the room is open:
- `community:member:removed` → `{ communityId, userId, reason: "left", actorId, updatedAt }`
- `community:stats:updated` → `{ communityId, memberCount: 0, updatedAt }`

**Never sent for this:**
- `community.deleted`
- any admin-transfer or role-changed event
- a "community closed" APNs push. The push service never notifies an actor about their own action.

**Community, leave from an already-closed community:** only the leave events. No second `community:closed`.

**Group, the last admin leaves an ACTIVE group.** On the leaver's personal channel:
- `group:disbanded` → `{ roomId, type: "GROUP", disbandedBy, disbandedAt }`
- `group:removed` → `{ roomId, reason: "LEAVE", removedAt }`

**Group, leave from a CLOSED group:** `group:removed` only. No `group:disbanded`.

Handlers must be idempotent. On the shared dev environment each personal-channel event can arrive more than once, one copy per gateway.

---

## 3. iOS implementation plan

### 3.1 Data you need at the moment the user taps Leave

| | Community | Group |
|---|---|---|
| Is the caller the admin? | `role == "ADMIN"` from a **fresh** `GET /communities/{id}` | membership role from the room or inbox row (live via `group:member:updated`) |
| Is the caller alone? | `memberCount <= 1` from the same fresh GET | fresh `GET /chat/group-members/{roomId}?limit=2` returns at most 1 row |
| Is it closed? | `status != "ACTIVE"` | inbox row `isClosed` / room `status == "CLOSED"` |

Fetch only when the caller is the admin; members keep today's flow. If the fresh read fails, fall back to cached values. The server re-checks everything on the write.

### 3.2 Decision (UseCase + ViewModel)

```swift
enum LeaveDialog: Equatable {
    case memberReason          // unchanged member flow
    case assignAdminFirst      // unchanged: others remain
    case leaveAndClose         // NEW: last member, entity open
    case plainLeave            // last member, entity already closed
}

struct ResolveLeaveDialogUseCase {
    func callAsFunction(isAdmin: Bool, aloneLive: Bool?, isClosed: Bool) -> LeaveDialog {
        guard isAdmin else { return .memberReason }
        guard aloneLive == true else { return .assignAdminFirst }   // unknown → today's safe behaviour
        return isClosed ? .plainLeave : .leaveAndClose
    }
}
```

- Community: `aloneLive = fresh.memberCount <= 1`, `isAdmin = fresh.role == "ADMIN"`, `isClosed = fresh.status != "ACTIVE"`.
- Group: `aloneLive = rosterPage.count <= 1`.

The ViewModel exposes `@Published var leaveDialog: LeaveDialog?` and `@Published var isLeaving: Bool`. The coordinator presents the alert or sheet.

### 3.3 Where Leave must appear

**Community:**
- The chat header menu → Leave Community, and the Info screen.
- The list row swipe or context menu → Leave.
- Multi-select → Leave selected (bulk).
- For the admin, keep the entry visible. The dialog decides.

**Group:**
- Today the admin's Leave is shown only when the group looks like it has one member. Base that check on the **live roster** (§3.1), not the stored count.
- Re-read the roster whenever a `group:member:*` event changes the count.
- Keep **Close Group** as it is.

**Closed entities:** the server accepts leave on a closed group or community. If the closed-state screen hides Leave, keep it at least on the list row so a remaining admin is never trapped.

### 3.4 Dialog copy (Localizable.strings; matches web)

| Key | en | vi | th |
|---|---|---|---|
| `community.leaveAndClose.title` | Leave and close this community? | Rời và đóng cộng đồng này? | ออกและปิดคอมมูนิตี้นี้หรือไม่? |
| `community.leaveAndClose.body` | You are the last member of this community. Leaving will close the community. Do you want to continue? | Bạn là thành viên cuối cùng của cộng đồng này. Rời đi sẽ đóng cộng đồng. Bạn có muốn tiếp tục không? | คุณเป็นสมาชิกคนสุดท้ายของคอมมูนิตี้นี้ การออกจะทำให้คอมมูนิตี้ถูกปิด ต้องการดำเนินการต่อหรือไม่? |
| `community.leaveAndClose.confirm` | Leave & Close Community | Rời & Đóng cộng đồng | ออกและปิดคอมมูนิตี้ |
| `group.leaveAndClose.title` | Leave and close this group? | Rời và đóng nhóm này? | ออกและปิดกลุ่มนี้หรือไม่? |
| `group.leaveAndClose.body` | You are the last member of this group. Leaving will close the group. Do you want to continue? | Bạn là thành viên cuối cùng của nhóm này. Rời đi sẽ đóng nhóm. Bạn có muốn tiếp tục không? | คุณเป็นสมาชิกคนสุดท้ายของกลุ่มนี้ การออกจะทำให้กลุ่มถูกปิด ต้องการดำเนินการต่อหรือไม่? |
| `group.leaveAndClose.confirm` | Leave & Close Group | Rời & Đóng nhóm | ออกและปิดกลุ่ม |

Actions: **Cancel** (`.cancel`) and **Leave & Close …** (`.destructive`). `plainLeave` uses the existing "Are you sure you want to leave this community/group?" confirm. `assignAdminFirst` is the existing dialog, unchanged.

### 3.5 Sending the request and handling the result

```swift
func confirmLeave() {
    guard !isLeaving else { return }               // double-tap guard; also disable the button
    isLeaving = true
    leaveUseCase.execute(entityId: id, payload: payload)   // admin: empty body
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isLeaving = false
            guard case let .failure(error) = completion else { return }
            switch error.apiCode {
            case "COMMUNITY_MEMBER_NOT_FOUND", "CHAT_NOT_A_MEMBER":
                self.didLeave()                    // the earlier attempt already went through
            case "COMMUNITY_ADMIN_CANNOT_LEAVE", "CHAT_OWNER_CANNOT_LEAVE":
                self.leaveDialog = .assignAdminFirst   // someone joined meanwhile; no error toast
            default:
                self.errorMessage = error.localizedMessage  // keep the dialog for a retry
            }
        } receiveValue: { [weak self] _ in self?.didLeave() }
        .store(in: &cancellables)
}
```

`didLeave()` does the following:
1. Delete the row from the GRDB list tables and from the in-memory list.
2. Clear the draft, the unread badge and cached pins or media index for that id.
3. Leave the socket room.
4. Pop the chat screen and return to the list. The coordinator replaces the stack so Back cannot reopen the room.
5. Show "You left the community" or "You left the group".

### 3.6 Realtime handling (other devices of the same user)

- **`community:membership:removed`:** delete the community row. This is unchanged, so old builds already do it.
- **`community:closed` with `reason == "LAST_MEMBER_LEFT"`:** **do not** show the closed banner or toast. The only recipient is the user who just left, and `membership:removed` follows immediately. For any other reason, keep today's behaviour.
- **`group:disbanded` / `group:removed`:** delete the row and pop the room if it is open. This is unchanged.
- Upsert or delete idempotently in GRDB, because duplicate deliveries happen.

### 3.7 Refresh, background and offline

- After a background-sync or cold start, `GET /communities/mine` and the chat inbox no longer return the entity. Remove anything local that is absent there.
- Never queue a Leave offline for a silent replay. If the device is offline, show the error and let the user retry, because the server must decide close vs. transfer at that moment.

---

## 4. Backward compatibility (no forced update)

| Old iOS build does… | What happens now |
|---|---|
| Shows "Assign admin" for a stale count of 2+ | Still wrong UX, but nothing breaks. Ship §3 to fix it. |
| Sole admin confirms the old "dissolve" dialog | Works. The community is **closed** instead of deleted, and the row is removed via `membership:removed`. |
| Bulk leave expects `DELETED` for the sole admin | Now receives `LEFT`. Already treated as removed. |
| Retries after a timeout | Gets 404. Old builds show an error; new builds treat it as success (§3.5). |

---

## 5. QA checklist (iOS)

1. Admin alone, active community: Leave → "Leave & Close Community" → confirm. The row disappears on all of the user's devices. Super Admin shows the community Closed with 0 members.
2. Admin + 1 member: Leave → Assign New Admin dialog, Leave disabled. **Unchanged.**
3. Admin + 1 member; the member leaves; the admin taps Leave → "Leave & Close".
4. The "Leave & Close" dialog is open; another user joins; the admin confirms → 400 → the Assign dialog appears, with no error toast and nothing closed.
5. Super-Admin-closed community, admin alone: Leave → plain confirm → the row disappears. Super Admin still shows it Closed, with no second close.
6. Super-Admin-closed community, admin + member: 400 `COMMUNITY_ADMIN_CANNOT_LEAVE` (transfer). **Unchanged.**
7. Admin alone, active group: Leave visible → "Leave & Close Group" → confirm → the group is gone and the room pops.
8. Admin + member group: no Leave in the header (Close Group only). **Unchanged.** When the member leaves, Leave appears live.
9. Group whose stored count is wrong ("3 members") but the admin is alone: Leave is still offered (live roster).
10. Double-tap confirm: exactly one request, or the 404 on the second one is handled as success.
11. Admin alone with a live stream: Leave & Close → the stream ends.
12. A member or moderator leaving: the reason picker flow, **unchanged**.

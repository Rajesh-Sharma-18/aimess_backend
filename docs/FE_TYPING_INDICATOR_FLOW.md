# AIMess — Typing Indicator Flow (Frontend Guide)

A complete, self-contained guide for implementing the **"X is typing…"** indicator correctly in private chat, group chat, and community chat.

> **Why this doc exists:** Typing indicators were appearing/disappearing inconsistently. The root cause was FE emitting `typing:start` / `typing:stop` **with an ack callback** that the server never answers. This guide explains the correct fire-and-forget pattern.

> **Source of truth:** `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` and `community.ns.ts` (code wins over docs).

---

## 0. The One Rule You Must Follow

> ### `typing:start` and `typing:stop` are FIRE-AND-FORGET. Emit them WITHOUT a callback.

These are the **only** chat/community events with no ack. Every other event (`*:message:send`, `*:message:read`, `auth:refresh`, …) returns an ack — these two do not.

```js
// ❌ WRONG — the callback is NEVER invoked. Your indicator will break.
socket.emit("typing:start", { communityId }, (ack) => {
  console.log("This line never runs");
});

// ✅ CORRECT — fire and forget
socket.emit("typing:start", { communityId });
```

If your typing logic is wrapped in a promise that waits for an ack, it will hang forever and the indicator will misbehave. **Remove the callback.**

---

## 1. End-to-End Flow Diagram

```
┌─────────────┐                  ┌───────────┐                 ┌─────────────┐
│  User A     │                  │  Gateway  │                 │  Users      │
│  (typing)   │                  │ /community│                 │  B, C, D    │
└──────┬──────┘                  └─────┬─────┘                 └──────┬──────┘
       │                               │                              │
       │ 1. emit "typing:start"        │                              │
       │    { communityId }            │                              │
       │    (NO callback!)             │                              │
       ├──────────────────────────────►│                              │
       │                               │ 2. broadcast "typing:start"  │
       │                               │    to the room               │
       │                               ├─────────────────────────────►│
       │                               │                              │ Shows
       │                               │  ⏱️ start 6s auto-stop timer │ "A is
       │                               │                              │ typing…"
       │                               │                              │
       │ 3a. keeps typing →             │                              │
       │     re-emit "typing:start"    │                              │
       │     (resets the 6s timer)     │                              │
       ├──────────────────────────────►│ ⏱️ timer reset               │
       │                               │                              │
       │ 3b. stops / sends message →    │                              │
       │     emit "typing:stop"        │                              │
       ├──────────────────────────────►│ 4. broadcast "typing:stop"   │
       │                               ├─────────────────────────────►│ Hides
       │                               │                              │ indicator
       │                               │                              │
       │  ──── OR if A crashes/drops ──│                              │
       │                               │ 5. 6s timer fires →           │
       │                               │    auto-broadcast typing:stop │
       │                               ├─────────────────────────────►│ Hides
       │                               │                              │ (safety net)
```

---

## 2. The Three Server-Side Safety Layers (free — you get these automatically)

| #   | Layer                        | What it does                                                                                    |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Re-emit resets the timer** | As long as A keeps typing and re-emits `typing:start`, the indicator stays alive.               |
| 2   | **6-second auto-stop**       | If A crashes mid-type, the server auto-broadcasts `typing:stop` after 6 s. No stuck indicators. |
| 3   | **Disconnect flush**         | If A's socket closes, the server broadcasts `typing:stop` for every room A was typing in.       |

**Bottom line:** even if your FE forgets to send `typing:stop`, the indicator self-heals within 6 seconds.

---

## 3. Emit Payloads (Client → Server)

### Private / Group chat (`/chat` namespace)

```js
chat.emit("typing:start", { conversationId: "abc123", senderName: "Alice" });
chat.emit("typing:stop", { conversationId: "abc123", senderName: "Alice" });
```

| Field            | Required | Notes                                               |
| ---------------- | -------- | --------------------------------------------------- |
| `conversationId` | ✅       | The private/group conversation id                   |
| `senderName`     | optional | Display name fallback if server snapshot is missing |

### Community chat (`/community` namespace)

```js
community.emit("typing:start", { communityId: "comm123", senderName: "Alice" });
community.emit("typing:stop", { communityId: "comm123", senderName: "Alice" });
```

| Field         | Required | Notes                                       |
| ------------- | -------- | ------------------------------------------- |
| `communityId` | ✅       | The community id                            |
| `roomId`      | optional | Defaults to `communityId` (the GeneralRoom) |
| `senderName`  | optional | Display name fallback                       |

> Invalid payloads are **silently dropped** — there is no error ack. Validate client-side before emitting.

---

## 4. Broadcast Payloads (Server → Client)

Both `typing:start` and `typing:stop` are received with the **same enriched shape**:

```ts
interface TypingBroadcast {
  conversationId: string; // == communityId on /community (legacy field name)
  communityId?: string; // only on /community
  userId: string; // server-authoritative — WHO is typing
  userDetails: {
    userId: string;
    username: string;
    displayName: string; // ← use this for "X is typing…"
    avatarUrl: string | null;
  };
  timestamp: number; // epoch ms
  senderName: string;
}
```

> `userDetails` is resolved **server-side once at connect** — you don't need to look up the user yourself. Trust `userId` (it's server-authoritative, not from the sender's payload).

---

## 5. Complete FE Implementation

### Step 1 — Detect typing & emit `typing:start` (debounced, guarded)

```js
let isTyping = false;
let stopDebounce = null;

function onInputChange() {
  // Emit start ONCE — not on every keystroke (prevents flicker)
  if (!isTyping) {
    isTyping = true;
    community.emit("typing:start", { communityId }); // ✅ no callback
  }

  // Reset the "stopped typing" countdown on each keystroke
  if (stopDebounce) clearTimeout(stopDebounce);
  stopDebounce = setTimeout(stopTyping, 3000); // 3s idle = stopped
}

function stopTyping() {
  if (!isTyping) return;
  isTyping = false;
  if (stopDebounce) {
    clearTimeout(stopDebounce);
    stopDebounce = null;
  }
  community.emit("typing:stop", { communityId }); // ✅ no callback
}
```

### Step 2 — Emit `typing:stop` the moment a message is sent

```js
function sendMessage(text) {
  stopTyping(); // stop typing instantly on send

  // This event DOES use a callback (it's a real ack event — unlike typing)
  community.emit(
    "community:message:send",
    {
      communityId,
      clientMessageId: uuid(),
      message: text,
      contentType: "TEXT",
    },
    (ack) => {
      if (ack.success) console.log("Sent:", ack.data.messageId);
    }
  );
}
```

### Step 3 — Listen for OTHER users typing

```js
const typingUsers = new Map(); // userId → displayName

community.on("typing:start", (data) => {
  if (data.userId === myUserId) return; // ignore your own echo
  typingUsers.set(data.userId, data.userDetails.displayName);
  renderTypingIndicator();

  // Optional client-side safety: auto-clear after 6s in case typing:stop is missed
  scheduleLocalExpiry(data.userId);
});

community.on("typing:stop", (data) => {
  if (data.userId === myUserId) return;
  typingUsers.delete(data.userId);
  renderTypingIndicator();
});
```

### Step 4 — Render (handles multiple simultaneous typers)

```js
function renderTypingIndicator() {
  const names = [...typingUsers.values()];
  if (names.length === 0) hideIndicator();
  else if (names.length === 1) showIndicator(`${names[0]} is typing…`);
  else if (names.length === 2)
    showIndicator(`${names[0]} and ${names[1]} are typing…`);
  else showIndicator(`${names.length} people are typing…`);
}
```

### Step 5 (optional but recommended) — Client-side expiry as a belt-and-braces

```js
const localTimers = new Map(); // userId → timeout

function scheduleLocalExpiry(userId) {
  const prev = localTimers.get(userId);
  if (prev) clearTimeout(prev);
  localTimers.set(
    userId,
    setTimeout(() => {
      typingUsers.delete(userId);
      localTimers.delete(userId);
      renderTypingIndicator();
    }, 6500)
  ); // slightly longer than the server's 6s
}
```

---

## 6. Throttling Rules

| Action         | Cadence                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `typing:start` | At most **1 per 3 seconds** while typing continuously (the `isTyping` guard handles this) |
| `typing:stop`  | Once, debounced — when typing actually stops or a message is sent                         |

Do **not** emit `typing:start` on every keystroke. Emit once when typing begins, then rely on the debounce for stop.

---

## 7. Common Mistakes → Fixes

| Symptom                               | Cause                                                                               | Fix                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Indicator **never appears**           | Emitted `typing:start` **with a callback**, code waited for an ack that never comes | Remove the callback — fire-and-forget                                   |
| Indicator **stuck "typing…" forever** | FE never sent `typing:stop` (no debounce)                                           | Add the 3s debounce + emit on send; the server's 6s timer is the backup |
| Indicator **flickers**                | Re-emitting `typing:start` on every keystroke                                       | Guard with the `isTyping` flag — emit `start` once                      |
| **You see your own** "typing…"        | Server broadcasts to the whole room, including the sender                           | Ignore broadcasts where `userId === myUserId`                           |
| Indicator shows **wrong name**        | Used `senderName` from payload instead of `userDetails.displayName`                 | Use `data.userDetails.displayName`                                      |

---

## 8. Quick Reference Card

```js
// ── EMIT (no callback, ever) ──────────────────────────────────────────
community.emit("typing:start", { communityId });
community.emit("typing:stop", { communityId });

// ── LISTEN ────────────────────────────────────────────────────────────
community.on("typing:start", ({ userId, userDetails }) => {
  if (userId !== myUserId) showTyping(userId, userDetails.displayName);
});
community.on("typing:stop", ({ userId }) => {
  if (userId !== myUserId) hideTyping(userId);
});

// ── GOLDEN RULES ──────────────────────────────────────────────────────
// 1. Never pass a callback to typing events.
// 2. Emit "start" once (guard with isTyping), debounce "stop" at 3s.
// 3. Always emit "stop" when a message is sent.
// 4. Ignore broadcasts where userId === your own.
// 5. The server auto-stops after 6s — it's a safety net, not your primary stop.
```

---

**See also:**

- `docs/FE_SOCKET_GUIDE.md` — full socket event reference (all namespaces)
- `docs/SOCKET_EVENTS.md` — deep contract notes
- `.claude/skills/community-socket-parity/SKILL.md` — community parity events

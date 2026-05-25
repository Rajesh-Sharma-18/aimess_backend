# AI-MESS Backend — Agent Operating Manual

**Read this file before doing anything else, on every task.** Then read the two skills below. Then start work.

This file is the orchestrator's playbook. It tells any agent (whether `implementer`, `reviewer`, `optimiser`, `tester`, or a generalist) what AI-MESS is, what's non-negotiable, and how the agents hand off to each other.

---

## 1. Project context — the one-paragraph version

**AI-MESS** is a Vietnamese-first social messaging platform: real-time messaging (1-1 + groups), themed communities, livestreaming inside communities, audio/video calls. Built on Node.js + Express + TypeScript, MongoDB (sharded), Redis (cache + pub/sub + Socket.IO adapter), Socket.IO, WebRTC signaling, RTMP livestreaming, FCM push. Current code is a **layered monolith**; target is an **11-service microservices** system (api-gateway, auth, user, community, messaging, delivery, notification, stream, call, mail, backoffice) wired by **gRPC for sync** and **RabbitMQ for async**. SOW Phase 1 covers 9 modules of behavior — every flow is spec'd in `backend-flow`.

The single most important pipeline in the system is **message send** — its design (immediate ACK + Redis pub/sub + Bull batch persist + RabbitMQ for offline push) is canonical and must not be broken by any change. See `backend-architecture §5d`.

---

## 2. Required reading on EVERY task — Step 0

Before writing or editing one line of code, every agent does this:

1. Read **`backend-flow`** skill — locate the section (§7–§15) matching the task. This is **WHAT** the feature should do: gates in order, side effects, silent-vs-notified branches, error codes, idempotency keys.
2. Read **`backend-architecture`** skill — locate the section (§5–§31) matching the layer/service you're touching. This is **HOW** the code is organized: services, layers, gRPC/RabbitMQ choice, MongoDB sharding + indexes, Bull queues, Redis usage, error envelope, observability.

If either skill is missing from your environment, **stop and surface that** — do not guess from memory. The skills live at:

- `/mnt/skills/user/backend-architecture/SKILL.md`
- `/mnt/skills/user/backend-flow/SKILL.md`

Or wherever your tooling syncs them.

**Reading the relevant sections of the skills is not optional, even for a one-line change.** A one-line change can break the silent-vs-notified contract or remove a gate without anyone noticing until production.

---

## 3. The four agents

| Agent             | Lane                                                                                                                                                                            | Default tools                                            | Reports to                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| **`implementer`** | Writes code: routes, controllers, services, repositories, models, sockets, workers, gRPC handlers, RabbitMQ producers/consumers                                                 | full (read, edit, bash)                                  | reviewer                                      |
| **`reviewer`**    | Audits diffs against the skills (layer boundaries, gates, indexes, security, DRY, idempotency, error envelope)                                                                  | read-only mostly; suggests edits but does not apply them | implementer (on block) or optimiser (on pass) |
| **`optimiser`**   | Performance & efficiency only — N+1, missing indexes, missing batches, missing cache, payload size, Socket.IO room fanout, MongoDB query patterns, Redis TTL, RabbitMQ prefetch | full; produces concrete patches                          | tester                                        |
| **`tester`**      | Writes + runs unit and integration tests; walks `§5d-failure` for any messaging change; confirms idempotency; produces "ready" or "red"                                         | full; bash for test runners                              | declares READY                                |

Each agent file lives at `.claude/agents/<name>.md` and has its own focused system prompt. **Each agent stays in its lane** — the implementer doesn't audit its own work; the reviewer doesn't write fixes; the optimiser doesn't change behavior; the tester doesn't refactor.

---

## 4. Standard task pipeline

```
                  user task
                      ↓
              ┌─────────────────┐
              │   implementer   │  → writes code, hands off diff + change summary
              └─────────────────┘
                      ↓
              ┌─────────────────┐
              │     reviewer    │  → PASS / COMMENT / BLOCK per category
              └─────────────────┘
                ↓pass        ↓block
                ↓     ┌─────back to implementer─────┐
                ↓     ↑                             ↑
              ┌─────────────────┐
              │    optimiser    │  → produces perf patches if any (does not change behavior)
              └─────────────────┘
                      ↓
              ┌─────────────────┐
              │     tester      │  → writes tests, runs them, walks failure modes
              └─────────────────┘
                ↓green        ↓red
                ↓            back to relevant agent
                ↓
                READY
```

### Compressed pipelines (when allowed)

| Task type                                                                               | Pipeline                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Trivial fix (typo, log msg, comment)                                                    | implementer → reviewer → READY                                                                                |
| Bug fix                                                                                 | implementer → reviewer → tester → READY                                                                       |
| New endpoint or socket event                                                            | implementer → reviewer → optimiser → tester → READY (full pipeline)                                           |
| Performance work                                                                        | optimiser → reviewer → tester → READY                                                                         |
| Refactor / restructuring                                                                | reviewer (analyze + plan) → implementer → reviewer → tester → READY                                           |
| Schema change / new index                                                               | implementer → reviewer → optimiser → tester → READY                                                           |
| Anything that touches `messages` / message-send / delivery-service / Bull `msg.persist` | **full pipeline, no compression**. The reviewer + tester must walk `§5d-failure` from `backend-architecture`. |

**Reviewer and tester are NEVER skipped on substantive changes.** "Substantive" = anything beyond a comment, log message, or pure rename caught by your IDE.

---

## 5. Handoff format — every agent's output ends with this

When an agent finishes its turn, the LAST block of its output is a structured handoff. Other agents (and the user) parse this. The format:

```
─────────────────────────────────────────────
HANDOFF
─────────────────────────────────────────────
From:        <agent name>
To:          <next agent name>  or  USER
Status:      DONE | BLOCKED | NEEDS_CLARIFICATION | READY
Summary:     one sentence describing what was done this turn
Touched:     file paths edited or created, one per line
Open items:  things the next agent needs to address (or "none")
─────────────────────────────────────────────
```

The next agent's first action is to read this handoff block and the touched files, then begin its lane.

**Status meanings:**

- `DONE` — this agent finished its lane successfully; hand off to the next agent in the pipeline.
- `BLOCKED` — this agent found something the previous agent must fix; the work goes back, not forward.
- `NEEDS_CLARIFICATION` — the task as stated is ambiguous; pause the pipeline and ask the user. Never invent the answer.
- `READY` — used only by the tester to signal the change is fully validated and ready to merge.

---

## 6. Non-negotiable rules (every agent honors these)

These are the rules that any AI-MESS backend change must satisfy regardless of lane:

1. **Skills first, code second.** Read `backend-flow` for behavior and `backend-architecture` for structure before writing or judging code.
2. **Gates in order, all of them.** Every flow in `backend-flow` lists its gates in evaluation order. The code must run them in that order. None can be skipped. None can be reordered without product approval.
3. **Silent-vs-notified is sacred.** Cancel friend request, decline, unfriend, block — all silent to the other party (by SOW design). Never add a notification to a silent branch.
4. **Friendship is required for 1-1 messaging and calls.** Group chat does NOT require friendship within the group; communities don't either. Don't conflate.
5. **Idempotency on every retry path.** Every Bull job, every RabbitMQ consumer, every endpoint that mobile clients might retry must dedupe correctly. The idempotency table is `backend-flow §17`.
6. **Every query has an index. Same change.** Adding a query without its supporting index is a BLOCK. The minimum index list is `backend-architecture §5g`.
7. **Layer boundaries are hard.** Mongoose calls only in repositories. Business logic only in services. Controllers are thin (validate → call service → format response). Workers and sockets call services, not repositories directly.
8. **gRPC for sync, RabbitMQ for async.** No internal REST between services. No `axios` from one service to another.
9. **`messages.idempotencyKey = clientLocalId`.** Unique sparse index. The single most-violated rule in retry scenarios.
10. **Privacy gates check blocks FIRST.** Block check goes before privacy check, before friendship check. Don't leak the existence of users who've hidden from the viewer.
11. **OTPs are anti-enumeration.** Forgot-password returns the same response shape whether the email exists or not.
12. **30-day grace for account deletion. Admin handover triggers immediately on day 0.** Recovered accounts come back as members, not admins.
13. **Error envelope.** Every response uses the canonical envelope: `{ ok: false, error: { code, message, details? } }`. Codes are the ones in `backend-flow §16` — stable, switched on by clients.
14. **No PII / secrets / tokens / OTPs / passwords in logs.** Not even at DEBUG level.
15. **The message delivery pipeline (`backend-architecture §5d`) is canonical.** Any change touching message send must preserve every property listed (5–15ms ACK, at-least-once persist, at-least-once delivery, idempotency on retry).
16. **Mobile clients are offline-first.** They replay. They reconnect. They expect the catch-up endpoint to work. Don't break it.

If a change appears to require violating one of these, **stop and escalate to the user**. Do not work around them silently.

---

## 7. What "READY" means

The tester is the only agent that can declare READY. To declare READY:

- ✅ All gates from the flow's `backend-flow` section have unit tests, including silent-vs-notified branches.
- ✅ The success path has an integration test.
- ✅ At least one realistic failure path has an integration test.
- ✅ For any message-pipeline change: `§5d-failure` is walked in tests (delivery-service down, Bull failure, RabbitMQ publish fail).
- ✅ For any retry-able flow: idempotency is verified by running the call twice and asserting one effect.
- ✅ For any new index: an EXPLAIN check confirms the query uses it.
- ✅ All tests are green locally.
- ✅ The reviewer's previous PASS is still valid (no code changes since).

If any ✅ is missing, the status is not READY — it's BLOCKED or DONE with open items.

---

## 8. How to invoke the agents

In Claude Code:

```bash
# Default — Claude picks the right agent based on the task
> claude "implement the friend-request endpoint"

# Explicit agent
> claude --agent implementer "implement POST /friends/requests"
> claude --agent reviewer "review the last commit"
> claude --agent optimiser "look at /conversations/:id/messages — feels slow"
> claude --agent tester "write tests for friend-request flow"
```

Or, from another agent, hand off explicitly:

```
HANDOFF
From: implementer
To:   reviewer
Status: DONE
Summary: implemented POST /friends/requests per backend-flow §8.1
Touched:
  src/modules/friends/friends.route.ts
  src/modules/friends/friends.controller.ts
  src/modules/friends/friends.service.ts
  src/modules/friends/friends.repository.ts
  src/modules/friends/friends.model.ts
Open items: none
```

The next agent reads that, the touched files, then begins.

---

## 9. When a task is too small for the full pipeline

Some tasks legitimately don't need every agent. Use judgment:

- "Rename a variable" — implementer alone is fine; no review needed.
- "Update a log message" — implementer alone.
- "Fix a typo in a comment" — implementer alone.

But the moment a change touches logic, the pipeline applies. **The bias is toward running more of the pipeline, not less.** When in doubt, run reviewer + tester.

---

## 10. When a task is too big for one pass

Some tasks (e.g. "implement Module 3 communities") are too big for a single implementer pass. Decompose:

1. Implementer (acting as PM first) lists the sub-tasks in order, one per flow from `backend-flow §9.x`.
2. Each sub-task runs the full pipeline independently.
3. Tester confirms the integration once the full module is in place (cross-flow tests).

The user should see this decomposition before the implementer begins — surface it as part of the first turn.

---

## 11. Maintenance

Update this file when:

- A new agent is added.
- The pipeline order changes.
- A new non-negotiable rule is added (or one is removed — that requires user approval).
- The handoff format changes.

Keep this file short and authoritative. Long, detailed reference material belongs in the skills (`backend-architecture`, `backend-flow`), not here.

---

## 12. TL;DR for any agent reading this for the first time

1. Read `backend-flow` for **what** the feature does.
2. Read `backend-architecture` for **how** the code is structured.
3. Stay in your lane (see §3).
4. Run the pipeline in order (§4).
5. End every turn with the handoff block (§5).
6. Honor the non-negotiables (§6).
7. Only the tester says READY (§7).

Now go look at the agent file for your lane.

# AIMess Scenario Validation Framework

> **Purpose.** Guarantee that no business action can ship if a critical
> side-effect is missing. Every state-changing action must fan out its full
> contract — **DB → Domain Event → Consumer → Socket → Push → In-App →
> Unread Badge → Analytics → Audit → Search → Cache** — and this framework
> continuously discovers, validates, and reports the gaps.
>
> **Origin.** A production incident — _admin adds community members → membership
> rows created → users notified of nothing_. Root cause: the business action
> succeeded but the notification side-effects were not delivered. This framework
> exists so that class of defect fails CI instead of reaching production.
>
> **Status.** Layer 1 (LLM agent) and Layer 2 (deterministic gate) are built and
> runnable today. See [`SYSTEM_SCENARIO_REVIEW.md`](SYSTEM_SCENARIO_REVIEW.md) for
> the current platform audit and [`SCENARIO_VALIDATION_REPORT.md`](SCENARIO_VALIDATION_REPORT.md)
> for the latest machine-generated run.

> **Stack note.** AIMess is **Express 5 + TypeScript (ESM)**, not NestJS (the
> architecture rules explicitly forbid NestJS). The validator is therefore a
> **standalone, framework-agnostic static-analysis tool** that reads source +
> contracts — not a NestJS module. This is the correct design regardless of web
> framework: validation must not depend on booting the app.

---

## 1. Architecture — two cooperating layers

The framework is deliberately split so that the **cheap, deterministic, offline**
checks gate CI, while the **semantic, discovering** checks run on demand.

```
                          ┌─────────────────────────────────────────────┐
                          │  CONTRACT REGISTRY  (tools/scenario-          │
                          │  validator/registry.json)                     │
                          │  business action → expected effects +         │
                          │  source-evidence pointers                     │
                          └───────────────┬───────────────┬──────────────┘
                                          │               │
        ┌─────────────────────────────────┘               └────────────────────────────┐
        ▼                                                                                ▼
┌───────────────────────────────┐                          ┌───────────────────────────────────────┐
│ LAYER 2 — DETERMINISTIC GATE   │                          │ LAYER 1 — LLM SCENARIO AGENT          │
│ validate.mjs + rules.json      │                          │ .claude/agents/scenario-validator.md  │
│ • greps ground-truth evidence  │  findings feed back ──►  │ • reads controllers/services/events   │
│ • applies rule engine          │  ◄── proposes new        │ • DISCOVERS actions missing from the  │
│ • scores risk                  │      registry entries    │   registry; reasons about semantics   │
│ • writes report + exit code    │                          │ • file:line evidence + risk + fix     │
│ • runs in CI, pre-commit, local│                          │ • run on a PR diff or a feature name  │
└───────────────────────────────┘                          └───────────────────────────────────────┘
        │                                                                                │
        └───────────────────────────► SCENARIO_VALIDATION_REPORT.md ◄────────────────────┘
                                       scenario-validation.json (CI artifact)
```

|          | **Layer 1 — Agent**                                          | **Layer 2 — Deterministic gate**                   |
| -------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Tech     | LLM subagent (Claude), tools: Read/Grep/Glob/Bash            | `node` script, zero deps                           |
| Strength | Semantics, **discovery** of unregistered actions, novel gaps | Speed, reproducibility, **CI gating**, no API cost |
| Weakness | Cost, non-determinism                                        | Only checks what's declared in the registry        |
| When     | New feature, PR review, deep audit, weekly sweep             | Every PR, pre-commit, release                      |
| Output   | Markdown verdict + fix recommendation                        | `SCENARIO_VALIDATION_REPORT.md` + JSON + exit code |

**They are complementary:** the agent finds _what to check_; the gate _keeps it
checked forever_. An agent run that finds a new action ends by appending a
registry entry, after which Layer 2 enforces it on every PR.

---

## 2. Rule engine design (Phase 6)

Rules are **data, not code** — `tools/scenario-validator/rules.json`. A _ruleset_
describes a **class** of action and which effects it MUST and SHOULD fan out:

```jsonc
"member_mutation": {
  "description": "A user is added/removed/role-changed in a community or group.",
  "required":    ["db","event","consumer","push","inapp","badge"],
  "recommended": ["socket","audit"],
  "riskOnMissingRequired":    "HIGH",
  "riskOnMissingRecommended": "MEDIUM"
}
```

Seeded rulesets (extend freely):

| Ruleset                                 | Required                                            | Recommended                | Risk       |
| --------------------------------------- | --------------------------------------------------- | -------------------------- | ---------- |
| `member_mutation`                       | db, event, consumer, push, inapp, badge             | socket, audit              | HIGH / MED |
| `privileged_action` (admin ban/suspend) | db, event, consumer, **audit, sessionInvalidation** | push, inapp                | HIGH       |
| `message_send`                          | db, socket                                          | push, badge, delivery      | HIGH / MED |
| `social_request` (friend)               | db, event, consumer, push, inapp, badge             | —                          | HIGH       |
| `lifecycle_self` (create/join)          | db, event                                           | consumer, audit            | MED / LOW  |
| `media_lifecycle` (scan/upload)         | db                                                  | socket, push, inapp, audit | MED        |
| `notification_lifecycle`                | db, socket, badge                                   | —                          | MED        |

These encode the user-facing rules verbatim, e.g.:

- **If Member Added → must have Notification + Audit + Domain Event** → `member_mutation`.
- **If Message Sent → must have Created event + Socket Broadcast + Notification + Delivery** → `message_send`.
- **If User Suspended → must have Audit + Notification + Session Invalidation** → `privileged_action`.

**Evaluation semantics** (per effect, per action):

| Contract declares                             | Evidence found? | Status                     |
| --------------------------------------------- | --------------- | -------------------------- |
| `evidence`                                    | yes             | ✅ PASS                    |
| `evidence`                                    | no              | ❌ FAIL                    |
| `waived: "<reason>"`                          | —               | ➖ WAIVED (documented n/a) |
| nothing, but ruleset `required`/`recommended` | —               | ❌ MISSING                 |
| nothing, not in ruleset                       | —               | · n/a                      |

Action verdict: **FAILED** if any _required_ effect is FAIL/MISSING; **WARN** if
only _recommended_ effects are missing; else **PASS**. A `waived` with a written
reason is the _only_ sanctioned n/a — silent omission is a defect (this is the
exact rule that the muted/warned consumer gap violated).

---

## 3. Discovery engine design (Phase 1)

Two discovery modes feed the registry:

**3a. Static-marker discovery (deterministic).** Each effect is detected by a
**declared evidence pointer** — a regex over a file or directory — so the system
maps the architecture without booting it:

| Effect                     | How it's detected in AIMess                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| DB write                   | repo `.create/.update*` / Prisma call in the owning service                                                                     |
| Domain event               | `publish*Safe(...)` → `sendToQueue(<queue>)` (plain durable queues, **not** a topic exchange — that's the real code)            |
| Consumer                   | a `case <EVENT>` in `apps/notifications-service/src/consumers/*.ts` (or other consumer dir)                                     |
| Socket event               | a `redis.publish("notify:\|conv:\|community:\|user:" …)` publisher (the `/notify`,`/chat`,`/community` namespaces only _relay_) |
| Push (FCM)                 | `pushToUser` → `sendPush` in `notifications-service`                                                                            |
| In-app inbox               | `createNotification` gRPC (chat-service owns the inbox at `:4004`)                                                              |
| Unread badge               | `notification:count_update` / `publishConvUpdatedSafe`                                                                          |
| Session invalidation       | `revokeAllForUser` / `forceLogout` handling in `auth-service`                                                                   |
| Audit                      | `auditService.record` / `recordAudit` / `AUDIT_ACTIONS.*`                                                                       |
| Analytics / Search / Cache | instrumentation hooks (mostly not yet wired — declared `waived` with reason)                                                    |

**3b. Semantic discovery (LLM agent).** The `scenario-validator` agent walks
controllers → services → repositories → publishers → consumers → sockets and
reports actions that have a DB write but no downstream fan-out — surfacing
_unregistered_ actions the deterministic layer can't know about. Its findings
become new `registry.json` entries.

The combined output is the **architecture map**: every service, its queues, its
consumers, and the publisher↔consumer pairing (a publisher with no matching
consumer `case` is the highest-signal finding — it's how the mute/warn drop and
the `admin.user.queue` gap were both found).

---

## 4. Business action catalog (Phase 2)

The registry is the live catalog. The seeded subset (12 actions) spans every
service and every verdict class; the full target catalog (~45 actions):

- **Community:** created, updated, deleted, member added/removed/promoted/demoted,
  muted/unmuted, warned, reported, joined, left, invite sent/accepted, join requested.
- **Private chat:** message sent/delivered/read, reaction added/removed, edited, deleted, blocked/unblocked.
- **Group chat:** created, member added/removed, admin changed, message sent/reply/forward/react/edit/delete.
- **User/Admin:** registered, verified, suspended, banned, unbanned, deleted.
- **Media:** uploaded, scan passed/failed, rejected, deleted.
- **Livestream:** created, started, ended, participant joined/left.
- **Notifications:** created, read, deleted.

Each lands in `registry.json` with its ruleset + evidence. Adding the rest is
mechanical (one JSON object each) — see the tool README.

---

## 5. Expected side-effect engine (Phase 3)

Every action _declares_ its expected effects in the registry. Example
(`community.member_added`):

```jsonc
"effects": {
  "db":       { "evidence": { "pattern": "createManyMembers|reactivateMemberWithSnapshot", "files": ["apps/community-service/src/services/community.service.ts"] } },
  "event":    { "evidence": { "pattern": "publishCommunityMemberAddedSafe", "files": ["apps/community-service/src/services/community.service.ts"] } },
  "consumer": { "evidence": { "pattern": "MEMBER_ADDED", "files": ["apps/notifications-service/src/consumers/community.consumer.ts"] } },
  "socket":   { "evidence": { "pattern": "notify:", "files": ["apps/chat-service/src/grpc/service-impl.ts"] } },
  "push":     { "evidence": { "pattern": "sendPush", "files": ["apps/notifications-service/src/services/push.service.ts"] } },
  "inapp":    { "evidence": { "pattern": "createNotification", "files": ["apps/notifications-service/src/services/push.service.ts"] } },
  "badge":    { "evidence": { "pattern": "count_update", "files": ["apps/chat-service/src/grpc/service-impl.ts"] } },
  "audit":    { "waived": "Community adds write no audit record (LOW)." },
  "analytics":{ "waived": "Analytics not instrumented platform-wide." }
}
```

The declaration is also the documentation: a reviewer reads one object and knows
the full contract. The evidence pointers make it _enforceable_.

---

## 6. Scenario Validation Agent (Phase 4) — input/output

**Input:** a feature name (`CommunityMemberAdded`), a PR diff, or "audit X".

**Output** (deterministic layer, real run):

```
Feature: Community Member Added   [community.member_added]
✅ Database update          PASS
✅ Domain event             PASS
✅ Event consumer           PASS
✅ Socket event             PASS
✅ Push notification (FCM)   PASS
✅ In-app notification       PASS
✅ Unread counter update     PASS
➖ Analytics event           WAIVED
➖ Audit log                 WAIVED
Risk: —
Recommendation: —
```

```
Feature: Admin: User Banned   [admin.user_banned]
✅ Database update          PASS
✅ Domain event             PASS
❌ Event consumer           FAIL
❌ Session invalidation     MISSING
❌ Push notification (FCM)   MISSING
❌ In-app notification       MISSING
✅ Audit log                PASS
Risk: HIGH
Recommendation: Build auth-service consumer on admin.user.queue → revoke
                sessions on forceLogout + notify on notifyUser.
                (missing: Event consumer, Session invalidation, Push, In-app)
```

The LLM agent produces the same checklist for actions not yet in the registry,
with `file:line` evidence and a one-line VERDICT (SHIP / FIX-FIRST / BLOCK).

---

## 7. Risk scoring model (Phase 5)

Risk is a function of _which_ effect class is missing, set per ruleset:

- **HIGH** — a user-facing business action whose **notification / socket / in-app**
  delivery is silently lost, OR a privileged action with **no audit / no session
  invalidation** (data-integrity / security). → blocks CI.
- **MEDIUM** — degraded delivery (in-room only, async-poll only) or a missing
  **audit/analytics** on a non-privileged action.
- **LOW** — missing metric/monitoring, or an unbuilt optional feature.

`riskWeights = { HIGH:100, MEDIUM:40, LOW:10 }` lets you trend a single platform
"side-effect debt" score over time. An action may set `riskOverride` (e.g.
`notification.deleted` is an unbuilt feature → LOW, not the ruleset's MEDIUM).

---

## 8. Report format (Phase 7)

`validate.mjs` writes [`SCENARIO_VALIDATION_REPORT.md`](SCENARIO_VALIDATION_REPORT.md)
(human) + `scenario-validation.json` (machine/CI). Structure: summary +
risk counts + CI verdict → per-domain checklist blocks (above) → a findings
table:

| Feature                  | Status | Risk   | Missing                                    | Service            |
| ------------------------ | ------ | ------ | ------------------------------------------ | ------------------ |
| Admin: User Banned       | FAILED | HIGH   | consumer, sessionInvalidation, push, inapp | backoffice-service |
| Group Member Added       | FAILED | HIGH   | event, consumer, push, inapp, badge        | chat-service       |
| Media: Virus Scan Failed | WARN   | MEDIUM | socket, push, inapp                        | media-service      |
| Notification Deleted     | FAILED | LOW    | db, socket, badge                          | chat-service       |

The JSON is the CI contract: `{ ciGate:{passed,blocking[]}, actions:[{id,status,risk,effects,missing}] }`.

---

## 9. CI/CD integration plan (Phase 9)

The gate runs at three points; all share one command and one exit code.

**Pre-commit** (`lint-staged` already exists) — run only when a service/event
file changed:

```jsonc
// lint-staged.config.mjs
"apps/**/src/**/*.ts": () => "pnpm validate:scenarios"
```

**Pre-PR / CI** — GitHub Actions:

```yaml
# .github/workflows/scenario-validation.yml
name: Scenario Validation
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: node tools/scenario-validator/validate.mjs # exit 1 fails the PR
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          { name: scenario-report, path: docs/SCENARIO_VALIDATION_REPORT.md }
```

**Release validation / architecture review** — the LLM agent runs on the release
branch diff for semantic discovery; the deterministic report is attached to the
release. The gate's exit code is the release blocker.

Root `package.json`:

```jsonc
"scripts": { "validate:scenarios": "node tools/scenario-validator/validate.mjs" }
```

---

## 10. Database schema (Phase — if needed)

The framework is **stateless by default** — the registry (git) is the source of
truth, the report is a build artifact. Persistence is optional, only to **trend
debt over time**. If you want dashboards, one append-only table in `admin_db`
(backoffice-service, Prisma) suffices:

```prisma
model ScenarioValidationRun {
  id           String   @id @default(uuid())
  commitSha    String
  branch       String
  ranAt        DateTime @default(now())
  totalActions Int
  passed       Int
  warned       Int
  failed       Int
  highRisk     Int
  mediumRisk   Int
  lowRisk      Int
  gatePassed   Boolean
  reportJson   Json     // the scenario-validation.json blob
  @@index([branch, ranAt])
}
```

A CI step POSTs `scenario-validation.json` to a backoffice admin endpoint after
each run. **Not required** for the gate to function.

---

## 11. Implementation plan (Phase — build-out, Express stack)

Built today (this commit):

1. ✅ Rule engine (`rules.json`) + contract registry (`registry.json`, 12 seeded actions).
2. ✅ Deterministic runner (`validate.mjs`) → report + JSON + CI exit code.
3. ✅ LLM agent (`.claude/agents/scenario-validator.md`).
4. ✅ Platform audit ([`SYSTEM_SCENARIO_REVIEW.md`](SYSTEM_SCENARIO_REVIEW.md)).

Build-out backlog: 5. Extend the registry to the full ~45-action catalog (§4) — mechanical. 6. Add the GitHub Actions workflow + `validate:scenarios` script + lint-staged hook. 7. (Optional) `ScenarioValidationRun` table + a backoffice ingest endpoint + a trend panel. 8. Add a **contract-guard unit test** in `notifications-service` that fails if any
`publish*Safe` constant has no consumer `case` — the runtime twin of the registry
check (catches the mute/warn class even for actions not yet registered). 9. Wire the LLM agent into a weekly scheduled run that opens a PR appending newly
discovered actions to the registry.

No NestJS modules, no app boot, no new runtime deps — the validator is tooling.

---

## 12. Future-feature checklist (Phase 10)

When any feature is created (e.g. **Poll Created**), the author (or the agent)
answers the registry's questions:

```
Poll Created — does it have…
  □ Database persistence?   → effects.db    evidence
  □ Domain event?           → effects.event evidence
  □ Consumer?               → effects.consumer evidence
  □ Socket update?          → effects.socket evidence
  □ Push notification?      → effects.push  evidence
  □ In-app + badge?         → effects.inapp / effects.badge
  □ Audit (if privileged)?  → effects.audit
  □ Analytics?              → effects.analytics
  □ Tests?                  → see §8 of SYSTEM_SCENARIO_REVIEW.md
```

Each box is a registry effect — declared with `evidence` (and the gate enforces
it) or `waived` with a reason. **A PR that adds a state-changing action without a
registry entry should itself fail review** (a meta-rule the agent enforces on the
diff). That is the end state: _no business action ships without a validated
side-effect contract._

---

## Appendix — example validations (real, from the seeded run)

| Feature                            | Verdict          | Why                                                         |
| ---------------------------------- | ---------------- | ----------------------------------------------------------- |
| Community Member Added             | ✅ PASS          | full chain wired on disk (deploy S1 to production)          |
| Community Member Muted / Warned    | ✅ PASS          | consumer cases added (commit `3792a73`)                     |
| Private Message Sent               | ✅ PASS          | own `conv:` channel + push + delivery                       |
| Friend Request Sent                | ✅ PASS          | event → consumer → push → inbox                             |
| **Admin: User Banned / Suspended** | ❌ FAILED (HIGH) | no `admin.user.queue` consumer → no force-logout, no notify |
| **Group Member Added**             | ❌ FAILED (HIGH) | in-room system message only; no event/consumer/push         |
| **Media: Virus Scan Failed**       | ⚠️ WARN (MED)    | async rejection is poll-only; no socket/push                |
| **Notification Deleted**           | ❌ FAILED (LOW)  | delete path unbuilt                                         |

Run it yourself: `pnpm validate:scenarios`.

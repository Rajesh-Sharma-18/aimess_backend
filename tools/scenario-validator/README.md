# Scenario Validation Framework (tool)

Deterministic CI gate that proves every business action fans out its expected
side-effects (DB → event → consumer → socket → push → in-app → badge → … →
audit). Catches the "business action succeeds but the user is never notified"
defect class **before it ships**.

This is **Layer 2** (deterministic). **Layer 1** is the LLM agent
`.claude/agents/scenario-validator.md`, which discovers actions _missing_ from
the registry. Full design: [`docs/SCENARIO_VALIDATION_FRAMEWORK.md`](../../docs/SCENARIO_VALIDATION_FRAMEWORK.md).

## Run

```bash
pnpm validate:scenarios          # or: node tools/scenario-validator/validate.mjs
```

Writes [`docs/SCENARIO_VALIDATION_REPORT.md`](../../docs/SCENARIO_VALIDATION_REPORT.md)

- `docs/scenario-validation.json`. **Exits non-zero** when any action is FAILED
  at risk ≥ `ciGate.failAtRisk` (HIGH) — wire it into CI to block the PR.

## Files

| File            | Purpose                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `rules.json`    | Rule engine: per _class_ of action, which effects are `required` / `recommended` + the risk if missing.                                |
| `registry.json` | Contract registry: each business action + its expected effects + the **source evidence** (regex + file/dir) that proves each is wired. |
| `validate.mjs`  | Runner: greps evidence (ground truth) → applies rules → scores risk → writes report → CI exit code. Zero deps.                         |

## Add a feature (Phase 10)

When you ship a new business action, add one entry to `registry.json`:

```jsonc
{
  "id": "community.poll_created",
  "title": "Poll Created",
  "domain": "Community",
  "service": "community-service",
  "ruleSet": "member_mutation", // pick a ruleset from rules.json
  "impact": "Members not told a poll opened.",
  "fix": "Publish community.poll_created → notifications consumer → pushToUser.",
  "effects": {
    "db": {
      "evidence": {
        "pattern": "createPoll",
        "files": ["apps/community-service/src/services/poll.service.ts"],
      },
    },
    "event": {
      "evidence": {
        "pattern": "publishPollCreatedSafe",
        "dir": "apps/community-service/src",
      },
    },
    "consumer": {
      "evidence": {
        "pattern": "POLL_CREATED",
        "dir": "apps/notifications-service/src/consumers",
      },
    },
    "audit": { "waived": "Self-action; no audit needed." },
  },
}
```

- An effect with `evidence` is **checked** against the working tree (PASS/FAIL).
- An effect with `waived: "<reason>"` is a documented **n/a** (➖). A required
  effect with no `evidence` and no `waived` is reported **MISSING** (a defect).
- `riskOverride` on an action overrides the ruleset's risk.

Detection is intentionally simple (regex over declared files/dirs), so it is
fast, reproducible, and offline. The LLM agent handles semantics and discovery.

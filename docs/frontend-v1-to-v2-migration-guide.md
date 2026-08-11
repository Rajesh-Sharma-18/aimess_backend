# Frontend migration guide — see `frontend-v2-to-v1-migration-guide.md`

This file exists only as a pointer, because the migration ran in the **opposite**
direction to what this filename suggests.

The original plan was to retire V1 and make V2 the single surface. The audit found
that V2 was not a second version of the API at all — it was a parallel
pagination-contract variant of **12** endpoints, against ~276 on V1. Promoting the
whole surface to `/api/v2` would have renamed 264 working endpoints for no
behavioral gain, so the decision was to invert it: fold V2's capabilities into V1
and delete `/api/v2`.

**The guide you want is [`frontend-v2-to-v1-migration-guide.md`](./frontend-v2-to-v1-migration-guide.md).**

Background and the full endpoint-by-endpoint comparison:
[`v2-to-v1-consolidation-audit.md`](./v2-to-v1-consolidation-audit.md).

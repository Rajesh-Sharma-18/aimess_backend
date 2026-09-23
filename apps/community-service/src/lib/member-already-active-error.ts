/**
 * Thrown by the guarded reactivation when the member row is ALREADY ACTIVE —
 * a concurrent activation (approve, Add Member, public self-join, the
 * PRIVATE→PUBLIC auto-resolve) won. Callers treat it exactly like the P2002 a
 * losing `createMember` gets: a graceful no-op, never a second join.
 */
export class MemberAlreadyActiveError extends Error {
  constructor() {
    super("COMMUNITY_MEMBER_ALREADY_ACTIVE");
    this.name = "MemberAlreadyActiveError";
  }
}

import { logger } from "@aimess/logger";

import { prisma } from "../config/prisma.js";
import { isDisposableEmail } from "./disposable-email.js";

/**
 * Disable any admin account whose address is on a public disposable-mail
 * domain.
 *
 * The shipped bootstrap super-admin was seeded on `yopmail.com`, whose inbox
 * anyone can read without signing in. Password reset sends a code to that
 * inbox, so the account handed over the whole backoffice — every RBAC
 * permission on the platform — to anyone who knew the address, with nothing to
 * guess.
 *
 * The seed and the reset path now refuse such addresses. That protects a NEW
 * environment and does nothing for the ones that already ran the old seed,
 * where the account is sitting there right now. Leaving that as a line in a
 * runbook means it stays live until somebody reads the runbook.
 *
 * So it is reconciled at boot instead. `DISABLED`, not deleted: deleting an
 * admin row loses the audit trail that references it, and disabling already
 * makes the account unusable for login and for password reset. An operator who
 * wants the account back gives it a real address and re-enables it.
 *
 * Runs once per start rather than on a timer — new admins are created through
 * an API that already rejects these domains, so the only way one appears is a
 * database written by hand or an older build.
 */
export async function reconcileDisposableAdmins(): Promise<number> {
  const candidates = await prisma.adminUser.findMany({
    where: { status: { in: ["ACTIVE", "INVITED"] } },
    select: { id: true, email: true },
  });

  const offenders = candidates.filter((admin) => isDisposableEmail(admin.email));
  if (offenders.length === 0) return 0;

  await prisma.adminUser.updateMany({
    where: { id: { in: offenders.map((admin) => admin.id) } },
    data: { status: "DISABLED" },
  });

  // Loud, and naming the addresses: an operator has to know which accounts
  // stopped working and why, or this looks like an outage.
  logger.warn(
    "disabled admin accounts on public disposable-mail domains — their password-reset inbox is readable by anyone",
    {
      service: "backoffice-service",
      accounts: offenders.map((admin) => admin.email),
    }
  );

  return offenders.length;
}

import { transporter } from "./transporter.js";
import { env } from "../../config/env.js";
import { logger } from "@aimess/logger";
import { maskEmailForLog } from "@aimess/utils";

interface SendMailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendMail({ to, subject, html }: SendMailParams) {
  const info = await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    html,
  });
  // Digest + domain, never the address: see `maskEmailForLog`. This is the one
  // path every OTP mail goes through, so the raw form made the log a user list.
  logger.info(`Mail sent to ${maskEmailForLog(to)}: ${info.messageId}`);
  return info;
}

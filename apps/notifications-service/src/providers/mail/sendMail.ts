import { transporter } from "./transporter.js";
import { env } from "../../config/env.js";
import { logger } from "@aimess/logger";

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
  logger.info(`Mail sent to ${to}: ${info.messageId}`);
  return info;
}

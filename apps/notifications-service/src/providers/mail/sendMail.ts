import { transporter } from "./transporter.js";
import { logger } from "@aimess/logger";

interface SendMailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendMail({ to, subject, html }: SendMailParams) {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
    });

    logger.info("Mail sent:", info.messageId);
    return info;
  } catch (error) {
    logger.error("Mail Error:", error);
    return null;
  }
}

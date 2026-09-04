import nodemailer from "nodemailer";
import { env } from "../../config/env.js";

/**
 * On port 465 the connection is TLS from the first byte. On any other port
 * (587 is the usual production choice) nodemailer only upgrades
 * OPPORTUNISTICALLY via STARTTLS — so if the relay does not advertise it, or an
 * on-path attacker strips the capability from the EHLO response, it silently
 * continues in cleartext and sends the SMTP credentials plus the message body.
 * The bodies here are registration, password-reset, link-email and
 * change-email OTP codes, so a downgrade hands an observer a live
 * account-recovery code together with the address it belongs to.
 *
 * `requireTLS` makes the send FAIL instead of falling back to plaintext, and
 * the floor pins out the obsolete protocol versions.
 */
const isLoopbackRelay = ["localhost", "127.0.0.1", "::1"].includes(
  env.SMTP_HOST.trim().toLowerCase()
);

export const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  // A loopback relay (MailHog and friends in local development) speaks no TLS
  // at all; requiring it there would break the dev mail flow without protecting
  // anything, since the traffic never leaves the machine.
  requireTLS: env.SMTP_PORT !== 465 && !isLoopbackRelay,
  tls: { minVersion: "TLSv1.2" },
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

import type {
  AdminPasswordResetOtpRequestedPayload,
  ChangeEmailOtpRequestedPayload,
  LinkEmailOtpRequestedPayload,
  PasswordResetOtpRequestedPayload,
  UserCreatedPayload,
} from "@aimess/shared-types";

import { sendMail } from "../providers/mail/sendMail.js";
import { adminPasswordResetOtpEmail } from "../providers/mail/templates/admin-password-reset-otp.js";
import { changeEmailOtpEmail } from "../providers/mail/templates/change-email-otp.js";
import { linkEmailOtpEmail } from "../providers/mail/templates/link-email-otp.js";
import { passwordResetOtpEmail } from "../providers/mail/templates/password-reset-otp.js";

export async function handleUserRegistered(_data: UserCreatedPayload) {
  //   await sendMail({
  //     to: data.email,
  //     subject: "Welcome to AIMess",
  //     html: welcomeEmail(data.name),
  //   });
  //   if (data.fcmToken) {
  //     await sendPush({
  //       token: data.fcmToken,
  //       title: "Welcome",
  //       body: "Welcome to AIMess",
  //     });
  //   }
}

export async function handlePasswordResetOtpRequested(
  data: PasswordResetOtpRequestedPayload
): Promise<void> {
  const { subject, html } = passwordResetOtpEmail({
    code: data.code,
    ttlSeconds: data.ttlSeconds,
  });
  await sendMail({ to: data.email, subject, html });
}

export async function handleAdminPasswordResetOtpRequested(
  data: AdminPasswordResetOtpRequestedPayload
): Promise<void> {
  const { subject, html } = adminPasswordResetOtpEmail({
    code: data.code,
    ttlSeconds: data.ttlSeconds,
  });
  await sendMail({ to: data.email, subject, html });
}

export async function handleLinkEmailOtpRequested(
  data: LinkEmailOtpRequestedPayload
): Promise<void> {
  const { subject, html } = linkEmailOtpEmail({
    code: data.code,
    ttlSeconds: data.ttlSeconds,
  });
  await sendMail({ to: data.email, subject, html });
}

export async function handleChangeEmailOtpRequested(
  data: ChangeEmailOtpRequestedPayload
): Promise<void> {
  const { subject, html } = changeEmailOtpEmail({
    code: data.code,
    ttlSeconds: data.ttlSeconds,
  });
  await sendMail({ to: data.email, subject, html });
}

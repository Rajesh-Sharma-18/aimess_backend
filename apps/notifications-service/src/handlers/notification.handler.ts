import type {
  PasswordResetOtpRequestedPayload,
  UserCreatedPayload,
} from "@aimess/shared-types";

import { sendMail } from "../providers/mail/sendMail.js";
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

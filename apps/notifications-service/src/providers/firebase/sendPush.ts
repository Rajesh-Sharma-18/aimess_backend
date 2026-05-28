import { messaging } from "./firebase.js";
import { logger } from "@aimess/logger";

interface SendPushParams {
  token: string;
  title: string;
  body: string;
}

export async function sendPush({ token, title, body }: SendPushParams) {
  try {
    const response = await messaging.send({
      token,
      notification: {
        title,
        body,
      },
    });

    logger.info("Push sent:", response);
    return response;
  } catch (error) {
    logger.error("FCM Error:", error);
    return null;
  }
}

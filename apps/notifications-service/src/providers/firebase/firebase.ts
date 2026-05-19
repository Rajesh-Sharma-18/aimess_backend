import admin from "firebase-admin";
import { env } from "../../config/env.js";
import type { Messaging } from "firebase-admin/messaging";

const app = admin.apps.length
  ? admin.app()
  : admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });

export const messaging = admin.messaging(app) as Messaging;

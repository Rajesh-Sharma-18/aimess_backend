import apn from "@parse/node-apn";
import { env } from "../../config/env.js";

export const apnsProvider = new apn.Provider({
  token: {
    key: env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
  },
  production: env.APNS_PRODUCTION,
});

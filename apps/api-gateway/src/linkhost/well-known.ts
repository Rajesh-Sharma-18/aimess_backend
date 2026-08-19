import {
  env,
  getAndroidCertFingerprints,
  getAppleAppIds,
} from "../config/env.js";

/**
 * Android Digital Asset Links (`/.well-known/assetlinks.json`) — proves domain
 * ownership so `https://aimess.me/*` opens the app via verified App Links
 * (spec §7.1). List BOTH the upload cert and the Play App Signing cert.
 */
export function buildAssetLinks(): unknown {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: env.ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: getAndroidCertFingerprints(),
      },
    },
  ];
}

/**
 * Apple App Site Association (`/.well-known/apple-app-site-association`) — drives
 * iOS Universal Links. Served as `application/json`, NO file extension, NO
 * redirect.
 *
 * Claims only the three NAMESPACED link prefixes, never `"/*"`: the link host is
 * shared with the marketing site, so claiming every path would make the app
 * swallow `/terms-of-service` and `/privacy-policy` (spec §2, §6.6). Bare
 * `/<handle>` is deliberately not claimed for the same reason — it keeps the
 * one-tap interstitial fallback (spec §3.4).
 *
 * Inert until iOS ships an associated-domains entitlement and `APPLE_APP_IDS`
 * is populated (spec §8.1).
 */
export function buildAppleAppSiteAssociation(): unknown {
  return {
    applinks: {
      details: [
        {
          appIDs: getAppleAppIds(),
          components: [
            { "/": "/+*", comment: "Private community invite" },
            { "/": "/g/*", comment: "Group invite" },
            { "/": "/community/*", comment: "Public community" },
          ],
        },
      ],
    },
  };
}

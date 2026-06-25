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
 * iOS Universal Links (spec §7.2). Served as `application/json`, NO file
 * extension, NO redirect. `"/": "/*"` claims every path on the link host.
 */
export function buildAppleAppSiteAssociation(): unknown {
  return {
    applinks: {
      details: [
        {
          appIDs: getAppleAppIds(),
          components: [{ "/": "/*", comment: "All AIMESS community links" }],
        },
      ],
    },
  };
}

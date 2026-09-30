/**
 * Registers the CDNetworks live-transcode ABR ladder on the push domain
 * (AddLiveDomainTranscode). Transcode config is DOMAIN-level and applies to every
 * stream on the domain, so this is a one-shot admin action — not part of the
 * per-stream lifecycle.
 *
 * The rungs here MUST match `CDN_TRANSCODE_TIERS` (the delivery switch) — the
 * suffixName becomes `<playbackId>_<suffix>` in the playback URL. Keys also match
 * the frontend's quality ladder ("720p" | "480p").
 *
 * ⚠️ Transcoding is a BILLED CDNetworks add-on and must be enabled on the account
 * first (same as the StopLivestreaming "forbid" permission). Until then the API
 * answers 200 with a logical failure in the body — which this script prints.
 *
 * DRY RUN by default (prints the planned profiles + current config); pass
 * `--apply` to actually register them.
 *
 * Usage:
 *   pnpm --filter @aimess/stream-service exec tsx scripts/provision-cdn-transcode.ts [--apply]
 */
import { env } from "../src/config/env.js";
import {
  CdnService,
  type CdnTranscodeProfile,
} from "../src/services/cdn.service.js";

const APPLY = process.argv.includes("--apply");

/**
 * The ladder. `resolutionAutoLimit:1` so a smaller source is never upscaled (a
 * 720p push won't be blown up to 1080p — CDN keeps it at source), `bitrateLimit:1`
 * so the output bitrate never exceeds the source. Ascending `priority` mirrors
 * resolution; suffixName drives both the URL and the frontend quality key.
 */
const PROFILES: CdnTranscodeProfile[] = [
  // Only 720p + 480p are provisioned on the account (2026-09-30).
  { suffixName: "720p", priority: 30, resolution: "1280*720", videoBitrate: 3000 },
  { suffixName: "480p", priority: 20, resolution: "854*480", videoBitrate: 1200 },
].map((p) => ({
  ...p,
  videoCodec: "h264",
  audioCodec: "aac",
  audioBitrate: 128,
  fps: 30,
  gop: 2,
  bitrateLimit: 1,
  resolutionAutoLimit: 1,
}));

async function main(): Promise<void> {
  const cdn = new CdnService();

  console.log(`Push domain : ${env.CDN_PUSH_DOMAIN || "(unset)"}`);
  console.log(`App         : ${env.CDN_APP}`);
  console.log(`API base    : ${env.CDN_API_BASE}`);
  console.log(`Ladder      : ${PROFILES.map((p) => p.suffixName).join(", ")}`);
  console.log(`CDN_TRANSCODE_TIERS (delivery switch): ${env.CDN_TRANSCODE_TIERS || "(unset — set this after provisioning to serve the rungs)"}`);
  console.log("");

  console.log("Current transcode config on the domain:");
  const before = await cdn.queryTranscode();
  console.log(`  HTTP ${before.status} ok=${before.ok}`);
  console.log(`  ${before.body.slice(0, 1500)}`);
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN — re-run with --apply to register the ladder above.");
    console.log("Profiles that would be sent:");
    console.log(JSON.stringify(PROFILES, null, 2));
    return;
  }

  console.log(`Applying ${PROFILES.length} profiles to ${env.CDN_PUSH_DOMAIN}...`);
  const result = await cdn.addTranscode(PROFILES);
  console.log(`  HTTP ${result.status} ok=${result.ok}`);
  console.log(`  ${result.body.slice(0, 1500)}`);
  if (!result.ok) {
    console.error(
      "\nADD FAILED. Most likely transcoding is not enabled on the account " +
        "(billed add-on) or the API credentials are wrong. Confirm entitlement " +
        "with CDNetworks, then re-run."
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nRe-querying to confirm:");
  const after = await cdn.queryTranscode();
  console.log(`  HTTP ${after.status} ok=${after.ok}`);
  console.log(`  ${after.body.slice(0, 1500)}`);
  console.log(
    `\nDone. Now set CDN_TRANSCODE_TIERS=${PROFILES.map((p) => p.suffixName).join(",")} ` +
      "and restart stream-service so playback exposes the rungs."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

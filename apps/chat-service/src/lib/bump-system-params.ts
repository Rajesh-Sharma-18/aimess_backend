import type { SystemLineParams } from "../services/last-visible-resolver.js";

/** The SYSTEM re-render params of a previewed row; without them the gateway can only send the baked third-person English text. */
export function bumpSystemParams(m: SystemLineParams): {
  systemEvent?: string;
  systemData?: Record<string, unknown>;
  systemMessageType?: string;
  systemMetadata?: Record<string, unknown>;
} {
  return {
    systemEvent: m.systemEvent ?? undefined,
    systemData: (m.systemData ?? undefined) as
      | Record<string, unknown>
      | undefined,
    systemMessageType: m.systemMessageType ?? undefined,
    systemMetadata: (m.systemMetadata ?? undefined) as
      | Record<string, unknown>
      | undefined,
  };
}

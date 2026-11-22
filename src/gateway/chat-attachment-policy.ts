// Connection-level chat attachment ceilings shared by the parser and the
// `hello-ok` handshake. Kept out of chat-attachments.ts so the handshake path
// does not pull the media probe/store graph in just to read two numbers.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Default decoded per-file ceiling: 1 GiB. */
const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 1024;

/** Default decoded-size ceiling when `agents.defaults.mediaMaxMb` is unset or invalid. */
export const DEFAULT_CHAT_ATTACHMENT_MAX_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;

/** Resolve the maximum decoded attachment size accepted for chat inputs. */
export function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.mediaMaxMb;
  const mb = asPositiveFiniteNumber(configured) ?? DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  // mediaMaxMb only has to be positive, so a sub-byte value would floor to 0 and
  // a huge one overflows to Infinity, which serializes as null on the handshake
  // frame and fails its integer schema. Both ends have to stay representable.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
}

/**
 * Connection-wide decoded-size ceilings; MIME and count limits depend on the
 * entrypoint and model. Images must also fit the agent-hydration cap.
 *
 * These are per-attachment ceilings, never a frame budget: a file above what one
 * WebSocket frame can carry is streamed to the inbound media store through the
 * direct upload route and referenced from `chat.send` by upload ID. Clients
 * still bound every single request by `policy.maxPayload`.
 */
export function resolveChatAttachmentPolicy(cfg: OpenClawConfig) {
  const maxBytes = resolveChatAttachmentMaxBytes(cfg);
  return { maxBytes, maxImageBytes: Math.min(maxBytes, MAX_IMAGE_BYTES) };
}

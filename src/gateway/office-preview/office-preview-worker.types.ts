import type { SessionFileOfficeFormat } from "../../../packages/gateway-protocol/src/index.js";

/** One bounded parse request; bytes stay owned by the caller's buffer. */
export type OfficePreviewWorkerRequest = {
  format: SessionFileOfficeFormat;
  bytes: Uint8Array;
};

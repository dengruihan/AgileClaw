import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";

/** Loads a remote/local media URL and stages it into the outbound media store. */
export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  },
): Promise<{ path: string; contentType?: string }> {
  const { loadWebMedia } = await import("./web-media.js");
  const media = await loadWebMedia(mediaUrl, {
    ...buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
    }),
    documentFallback: true,
  });
  // Preserve source file names so outbound attachments keep useful names after UUID staging.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
    undefined,
    { preserveContentType: media.contentType === "application/octet-stream" },
  );
  return { path: saved.path, contentType: saved.contentType };
}

export async function resolveOutboundAttachmentFromBuffer(
  buffer: Buffer,
  maxBytes: number,
  options?: {
    contentType?: string;
    filename?: string;
    assertCommitAllowed?: () => void;
  },
): Promise<{ path: string; contentType?: string }> {
  const saved = await saveMediaBuffer(
    buffer,
    options?.contentType,
    "outbound",
    maxBytes,
    options?.filename,
    undefined,
    options?.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : undefined,
  );
  return { path: saved.path, contentType: saved.contentType };
}

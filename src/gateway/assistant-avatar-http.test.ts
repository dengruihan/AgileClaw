import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readImageMetadataFromHeader } from "../media/image-ops.js";
import { encodePngRgba } from "../media/png-encode.js";
import { prepareGatewayAvatarFile } from "./assistant-avatar-cache.js";
import { readGatewayAvatarThumbnail } from "./assistant-avatar-thumbnail.runtime.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { handleControlUiAvatarRequest } from "./control-ui.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps pending thumbnails coalesced beyond the completed-cache capacity", async () => {
  const workspace = tempRoots.make("openclaw-avatar-coalesce-");
  const sources = Array.from({ length: 5 }, (_, index) => {
    const avatarPath = path.join(workspace, `avatar-${index}.svg`);
    fs.writeFileSync(
      avatarPath,
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${index}</text></svg>`,
    );
    return prepareGatewayAvatarFile({
      path: avatarPath,
      stat: fs.statSync(avatarPath),
      body: fs.readFileSync(avatarPath),
    });
  });
  const gate = createDeferred();
  const decode = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    await gate.promise;
    return decode(...args);
  });
  const pending = sources.map((source) => readGatewayAvatarThumbnail(source));
  pending.push(readGatewayAvatarThumbnail(sources[0]!));
  gate.resolve();
  const images = await Promise.all(pending);

  expect(fetch).not.toHaveBeenCalled();
  expect(images[5]).toBe(images[0]);
});

// Two 2×2 red/blue frames encoded with img2webp; VP8X animation flag and timing are retained.
const ANIMATED_WEBP = Buffer.from(
  "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=",
  "base64",
);

it.each([
  ["image/png", "avatar.png", APNG_BYTES],
  ["image/webp", "avatar.webp", ANIMATED_WEBP],
  [
    "image/svg+xml",
    "avatar.svg",
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>café</text></svg>', "utf8"),
  ],
] as const)("preserves the bytes of a local %s avatar", async (extensionMime, filename, body) => {
  const workspace = tempRoots.make("openclaw-avatar-animation-");
  fs.writeFileSync(path.join(workspace, filename), body);
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace, identity: { avatar: filename } } } },
  };
  const { avatar: url } = await resolveGatewayAssistantAvatar({
    cfg: config,
    identity: await resolveAssistantIdentity({ cfg: config, agentId: "main" }),
    httpBasePath: "",
  });
  const response = makeMockHttpResponse();
  await handleControlUiAvatarRequest(
    { url, method: "GET", headers: {} } as IncomingMessage,
    response.res,
    { config },
  );
  expect(response.res.statusCode).toBe(200);
  expect(response.end).toHaveBeenCalledWith(body);
  expect(response.setHeader).toHaveBeenCalledWith("content-type", extensionMime);
});

it("serves a cached authenticated thumbnail for a versioned local avatar", async () => {
  const workspace = tempRoots.make("openclaw-avatar-thumbnail-");
  const pixels = randomBytes(640 * 640 * 4);
  const original = encodePngRgba(pixels, 640, 640);
  const avatarPath = path.join(workspace, "avatar.png");
  fs.writeFileSync(avatarPath, original);
  const config: OpenClawConfig = {
    gateway: { controlUi: { basePath: "/control" } },
    agents: {
      entries: {
        main: {
          workspace,
          identity: { avatar: "avatar.png" },
        },
      },
    },
  };
  const project = async () =>
    (
      await resolveGatewayAssistantAvatar({
        cfg: config,
        identity: await resolveAssistantIdentity({ cfg: config, agentId: "main" }),
        httpBasePath: "/control",
      })
    ).avatar;
  const url = await project();
  expect(url).toMatch(/^\/control\/avatar\/main\?v=[a-f0-9]+$/);
  const request = async (
    options: { method?: string; etag?: string; authorized?: boolean; url?: string } = {},
  ) => {
    const response = makeMockHttpResponse();
    await handleControlUiAvatarRequest(
      {
        url: options.url ?? url,
        method: options.method ?? "GET",
        headers: {
          ...(options.authorized === false ? {} : { authorization: "Bearer test-token" }),
          ...(options.etag ? { "if-none-match": options.etag } : {}),
        },
        socket: { remoteAddress: "127.0.0.1" },
      } as IncomingMessage,
      response.res,
      {
        config,
        basePath: "/control",
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      },
    );
    return response;
  };
  const first = await request();
  expect(first.res.statusCode).toBe(200);
  const thumbnail = first.end.mock.calls[0]?.[0];
  expect(Buffer.isBuffer(thumbnail)).toBe(true);
  expect(readImageMetadataFromHeader(thumbnail as Buffer)).toEqual({ width: 128, height: 128 });
  expect((thumbnail as Buffer).length).toBeLessThan(original.length / 10);
  expect(first.setHeader).toHaveBeenCalledWith(
    "cache-control",
    "private, max-age=31536000, immutable",
  );
  expect(first.setHeader).toHaveBeenCalledWith("vary", "Authorization, Cookie");
  const etag = first.setHeader.mock.calls.find(([name]) => name === "etag")?.[1] as string;
  expect(etag).toBeTruthy();

  const fileReads = [
    vi.spyOn(fs, "read"),
    vi.spyOn(fs, "openSync"),
    vi.spyOn(fs, "realpathSync"),
    vi.spyOn(fs, "readFileSync"),
  ];
  const cached = await request();
  expect(cached.end).toHaveBeenCalledWith(thumbnail);
  const head = await request({ method: "HEAD" });
  expect(head.setHeader).toHaveBeenCalledWith(
    "content-length",
    String((thumbnail as Buffer).length),
  );
  expect(head.end.mock.calls[0]?.[0]).toBeUndefined();
  expect((await request({ etag })).res.statusCode).toBe(304);
  expect((await request({ etag, authorized: false })).res.statusCode).toBe(401);
  for (const read of fileReads) {
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  }

  const replacement = encodePngRgba(Buffer.alloc(640 * 640 * 4, 120), 640, 640);
  fs.writeFileSync(path.join(workspace, "replacement.png"), replacement);
  fs.renameSync(path.join(workspace, "replacement.png"), avatarPath);
  const replacedUrl = await project();
  expect(replacedUrl).not.toBe(url);
  const replaced = await request({ url: replacedUrl, etag });
  expect(replaced.res.statusCode).toBe(200);
  expect(replaced.end.mock.calls[0]?.[0]).not.toEqual(thumbnail);
  const stale = await request();
  expect(stale.setHeader).toHaveBeenCalledWith("cache-control", "private, no-cache");
});

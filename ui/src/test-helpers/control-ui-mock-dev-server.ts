import { spawn, type ChildProcessByStdio } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type ControlUiMockDevServer = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  url: string;
  output: () => string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/** Starts the standalone `scripts/control-ui-mock-dev.ts` server for a real dev-mock flow. */
export async function startControlUiMockDevServer(options?: {
  fixture?: string;
  fixturePath?: string;
}): Promise<ControlUiMockDevServer> {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}${options?.fixturePath ?? "/"}`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      ...(options?.fixture ? ["--fixture", options.fixture] : []),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const server = { child, url, output: () => output };

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Control UI mock server exited before startup\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return server;
      }
    } catch {}
    await delay(100);
  }

  await stopControlUiMockDevServer(server);
  throw new Error(`timed out waiting for Control UI mock server\n${output}`);
}

export async function stopControlUiMockDevServer(
  server: ControlUiMockDevServer | undefined,
): Promise<void> {
  if (server) {
    await stopChildProcess(server.child, 5_000);
  }
}

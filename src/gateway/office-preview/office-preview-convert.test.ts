import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertOfficeDocumentToPdf,
  GOTENBERG_LIBREOFFICE_CONVERT_PATH,
} from "./office-preview-convert.js";
import { OFFICE_PREVIEW_MAX_PDF_BYTES } from "./office-preview-limits.js";

type Handler = (req: IncomingMessage, res: import("node:http").ServerResponse) => void;

const servers: Server[] = [];

async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const docxBytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("synthetic-docx-body"),
]);

describe("Gotenberg conversion client", () => {
  it("uploads the document as the `files` multipart field and returns the PDF", async () => {
    let contentType = "";
    let body = Buffer.alloc(0);
    let path = "";
    const { baseUrl } = await startServer(async (req, res) => {
      path = req.url ?? "";
      contentType = req.headers["content-type"] ?? "";
      body = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.7\nconverted");
    });

    const result = await convertOfficeDocumentToPdf({
      bytes: docxBytes,
      filename: "budget.docx",
      baseUrl,
    });

    expect(result).toEqual({ pdf: Buffer.from("%PDF-1.7\nconverted") });
    expect(path).toBe(GOTENBERG_LIBREOFFICE_CONVERT_PATH);
    expect(contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
    expect(body.toString("latin1")).toMatch(/name="files"; filename="budget\.docx"/iu);
    expect(body.includes(docxBytes)).toBe(true);
  });

  it("reports a refused connection as unavailable", async () => {
    const { baseUrl, server } = await startServer((_req, res) => res.end());
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const result = await convertOfficeDocumentToPdf({
      bytes: docxBytes,
      filename: "budget.docx",
      baseUrl,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({ failure: "unavailable" });
  });

  it("reports a converter 5xx as unavailable and a 4xx as failed", async () => {
    let status = 503;
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("no converter");
    });

    expect(
      await convertOfficeDocumentToPdf({ bytes: docxBytes, filename: "x.docx", baseUrl }),
    ).toEqual({ failure: "unavailable" });

    status = 400;
    expect(
      await convertOfficeDocumentToPdf({ bytes: docxBytes, filename: "x.docx", baseUrl }),
    ).toEqual({ failure: "failed" });
  });

  it("rejects a non-PDF body instead of caching a broken preview", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>ocr failure</html>");
    });

    expect(
      await convertOfficeDocumentToPdf({ bytes: docxBytes, filename: "x.docx", baseUrl }),
    ).toEqual({ failure: "failed" });
  });

  it("bounds the converted response", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.write("%PDF-1.7\n");
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      while (sent <= OFFICE_PREVIEW_MAX_PDF_BYTES) {
        res.write(chunk);
        sent += chunk.length;
      }
      res.end();
    });

    expect(
      await convertOfficeDocumentToPdf({ bytes: docxBytes, filename: "x.docx", baseUrl }),
    ).toEqual({ failure: "too-large" });
  });

  it("bounds a stalled conversion", async () => {
    const { baseUrl } = await startServer(() => {
      // Never answer: the client's own timeout must fail the request.
    });

    expect(
      await convertOfficeDocumentToPdf({
        bytes: docxBytes,
        filename: "x.docx",
        baseUrl,
        timeoutMs: 100,
      }),
    ).toEqual({ failure: "unavailable" });
  });
});

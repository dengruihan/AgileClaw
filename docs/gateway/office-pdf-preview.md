---
summary: "Convert Office attachments to PDF previews through an isolated Gotenberg service"
read_when:
  - You want DOCX, XLSX, or PPTX attachments to open with their original page layout
  - You run the Gateway in Docker or as a native service and need the conversion service running
  - You are checking what Office previews store, cache, or leave on disk
title: "Office PDF previews"
---

OpenClaw shows Office attachments as PDFs so the browser renders the layout the
author saved: Word page sizes, Excel print settings, and PowerPoint slide
geometry survive the round trip. The Gateway does not parse or re-lay out OOXML
itself. It uploads the original file to an isolated
[Gotenberg](https://gotenberg.dev) 9 service, receives `application/pdf`, and
serves those bytes to the Control UI PDF viewer.

## How it works

1. A client asks for an Office preview of a chat attachment, an optimistic
   upload, assistant media, or a workspace file.
2. The Gateway checks access and re-reads the bounded original (8 MiB cap).
3. The Gateway POSTs the file to `{base}/forms/libreoffice/convert` with the
   original filename, in a multipart field named `files`.
4. Gotenberg converts with LibreOffice and answers `application/pdf` (16 MiB
   output cap).
5. The Gateway returns the PDF bytes to the requesting client and keeps a copy
   only in an in-process cache: at most 8 entries, 64 MiB in total, evicted
   after 15 minutes idle, with one in-flight conversion per file identity.

The base URL is fixed by deployment shape, not by configuration:

- Gateway inside Docker: `http://gotenberg:3000` (Compose service name).
- Gateway on the native host: `http://127.0.0.1:3000`.

There is no environment variable, config key, or health probe for the
conversion service. A request that cannot reach it fails visibly (see
[When conversion is unavailable](#when-conversion-is-unavailable)) and the next
request tries again.

## What persists

| Item                    | Where it lives                                   | Lifetime                                        |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Original DOCX/XLSX/PPTX | Existing workspace, session, or artifact storage | Normal attachment lifetime                      |
| Preview PDF             | Gateway process memory only                      | Until eviction, idle expiry, or Gateway restart |
| Conversion workspace    | Gotenberg container `tmpfs`                      | Until the request finishes                      |

No preview PDF is written to disk, JSON/JSONL, or SQLite, and the conversion
container mounts no volume, so a converted document disappears with the
request. The Gateway process owns the cache; restarting it starts empty.

## Preview versus export

A preview is a transient rendering: it never becomes a file the user keeps, and
the cache is not an export or download source. The attachment's download action
still returns the original Office bytes with the original MIME type. A user who
wants to keep a PDF saves or prints it from their own PDF viewer; the Gateway
has no server-side PDF export endpoint and nothing in the preview cache is
persisted.

## Run the conversion service

### Docker Compose

The repository root `docker-compose.yml` starts `openclaw-gateway` and a
hardened `gotenberg` service on a shared internal network:

```bash
docker compose up -d
docker compose ps gotenberg
```

`gotenberg` publishes no host port. The Gateway joins the same internal
`openclaw-gotenberg` network and reaches `http://gotenberg:3000`; its default
network, published ports, state volumes, and update path are unchanged.

### Native host Gateway

A Gateway started outside Docker (systemd, launchd, or `openclaw gateway run`)
uses the reusable definition in `deploy/gotenberg/`. Its host overlay publishes
the API on loopback only:

```bash
docker compose -f deploy/gotenberg/compose.yaml \
  -f deploy/gotenberg/compose.host.yaml up -d
curl --fail http://127.0.0.1:3000/health
```

The Gateway keeps running under its existing service manager; only the
conversion container is added. Stop it with:

```bash
docker compose -f deploy/gotenberg/compose.yaml \
  -f deploy/gotenberg/compose.host.yaml down
```

### Upgrade the image

`gotenberg/gotenberg:9` tracks the Gotenberg 9 line, verified against 9.10.3
(`sha256:a7726e0f52a4344656031393f0f61fdf35cd28aaf697c7ac3aea9519d72d726e`).
Pin the digest in either compose file when a deployment must be reproducible:

```yaml
image: gotenberg/gotenberg:9@sha256:a7726e0f52a4344656031393f0f61fdf35cd28aaf697c7ac3aea9519d72d726e
```

Pull and recreate the container after an image change:
`docker compose pull gotenberg && docker compose up -d gotenberg`. Both compose
files must stay in sync; `deploy/gotenberg/verify.sh` compares the two service
definitions and fails when they diverge.

## Limits and isolation

The conversion service is deliberately small and unreachable:

| Control                         | Value                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Request body                    | 18 MiB (`--api-body-limit`), larger requests answer 413                                                 |
| Request timeout, queue included | 60 s (`--api-timeout`)                                                                                  |
| LibreOffice queue               | 4 waiting requests, then 429                                                                            |
| LibreOffice memory              | 768 MiB per conversion, then 422                                                                        |
| Container memory                | 2 GiB, `GOMEMLIMIT=1500MiB`                                                                             |
| Temporary space                 | 512 MiB `tmpfs` on `/tmp`, root filesystem read-only                                                    |
| Capabilities                    | all dropped, `no-new-privileges`, 512-process limit                                                     |
| Volumes                         | none                                                                                                    |
| Network                         | internal bridge only in Compose; loopback publish plus a non-masquerading bridge for the native overlay |
| Reachable routes                | LibreOffice conversion only; Chromium and PDF-engine routes disabled                                    |
| Outbound requests               | `downloadFrom` and webhooks disabled, LibreOffice may not open outbound URLs                            |

Only the LibreOffice conversion route is reachable, and only the Gateway
uploads files into it. Remote URLs are never fetched: a `downloadFrom` form
field or webhook header is ignored, and the container has no route to the public
internet.

The non-masquerading bridge behind the native overlay was verified on Linux
Docker Engine 29.1.3. Docker Desktop's Linux VM may not honor bridge driver
options, so on that host treat the disabled `downloadFrom`, webhooks, and
LibreOffice outbound URLs as the enforced control: they refuse a remote fetch
before any network call.

## When conversion is unavailable

Previews report a state on the request that needed a conversion, and the
attachment stays reachable:

- `unavailable`: the conversion service is not running, refused the
  connection, timed out, or answered with a server error. The attachment still
  downloads, and the next preview request retries the service.
- `failed`: the converter rejected the document or returned a non-PDF body.
- `password-protected`: encrypted OOXML packaging.
- `too-large`: the source is above 8 MiB or the PDF above 16 MiB.
- `invalid`: non-ZIP, renamed, or corrupt bytes.
- `unsupported`: legacy `.doc`/`.xls`/`.ppt` containers.

Non-Office attachments never request an Office preview: the request follows the
ordinary download delivery and returns no preview object at all.

None of these states block session loading, chat history, or downloads, and
none are cached, so a repaired deployment recovers on the next request. The
exact RPC and Control UI fields are in
[Building a Gateway client](/gateway/clients#preview-office-artifacts).

## Verify a deployment

`deploy/gotenberg/verify.sh` starts the stack in an isolated project, converts
the synthetic fixtures in `deploy/gotenberg/fixtures/` (a US Letter DOCX, an A4
landscape XLSX with a print area, and a 16:9 PPTX), and checks:

- `application/pdf` responses with the original page geometry
- Excel print settings and print area respected
- no persistent mounts, read-only root, dropped capabilities, capped `tmpfs`
- no route to the internet, no remote download or webhook fetch, 413 on an
  oversized body
- the Compose shape resolves `gotenberg:3000` on an internal network with no
  published host port

Pass `--keep` to leave the stack running on `127.0.0.1:3000` while you check
previews in the Control UI. Fixtures are synthetic and regenerable with
`deploy/gotenberg/fixtures/generate.py`.

## Troubleshooting

- `curl --fail http://127.0.0.1:3000/health` fails on a native host: the
  container is not running, or another process owns port 3000.
- Previews work for small files but fail for large ones: check the 8 MiB source
  cap and the 18 MiB body limit; both answer with a visible state, never a hang.
- Consecutive previews answer 429: the LibreOffice queue is saturated; reduce
  concurrent preview requests or raise `--libreoffice-max-queue-size`.
- Compose reports a network error for `gotenberg`: confirm both services join
  `openclaw-gotenberg` and that the service name was not renamed.

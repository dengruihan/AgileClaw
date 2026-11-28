# Gotenberg conversion service

Isolated [Gotenberg](https://gotenberg.dev) 9 deployment for Office PDF
previews. The Gateway uploads DOCX/XLSX/PPTX files and receives
`application/pdf`; nothing is stored by this service.

- `compose.yaml` - base service: internal network only, no published port, no
  volume, read-only root, `tmpfs` for conversions, LibreOffice routes only.
- `compose.host.yaml` - native-host overlay: publishes `127.0.0.1:3000` and
  adds a non-masquerading bridge so the container has no internet route.
- `fixtures/` - synthetic DOCX/XLSX/PPTX samples and their deterministic
  generator (`generate.py`, Python standard library only).
- `verify.sh` - starts the stack in an isolated Compose project and proves
  conversion, page geometry, and every isolation guarantee.

## Run it

Native-host Gateway (the Gateway itself stays under systemd/launchd):

```bash
docker compose -f deploy/gotenberg/compose.yaml \
  -f deploy/gotenberg/compose.host.yaml up -d
curl --fail http://127.0.0.1:3000/health
```

Gateway in Docker uses the repository root `docker-compose.yml` instead: the
`gotenberg` service joins the internal `openclaw-gotenberg` network and the
Gateway reaches `http://gotenberg:3000`. Keep that service definition in sync
with `compose.yaml`; `verify.sh` fails when the two diverge.

## Verify

```bash
deploy/gotenberg/verify.sh          # run every check, then remove the stack
deploy/gotenberg/verify.sh --keep   # leave it on 127.0.0.1:3000 for live checks
```

Requires Docker Engine with Compose v2, `curl`, Node.js, and a free
`127.0.0.1:3000`. Verified against `gotenberg/gotenberg:9` (9.10.3) with image
digest `sha256:a7726e0f52a4344656031393f0f61fdf35cd28aaf697c7ac3aea9519d72d726e`.

## Limits

| Control            | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Request body       | 18 MiB                                                               |
| Request timeout    | 60 s                                                                 |
| LibreOffice queue  | 4                                                                    |
| LibreOffice memory | 768 MiB per conversion                                               |
| Container memory   | 2 GiB (`GOMEMLIMIT=1500MiB`)                                         |
| Temporary space    | 512 MiB `tmpfs`                                                      |
| Reachable routes   | LibreOffice conversion only; Chromium and PDF-engine routes disabled |
| Outbound           | downloadFrom and webhooks disabled, LibreOffice URLs denied          |

Deployment behavior, degraded preview states, and troubleshooting are documented
in `docs/gateway/office-pdf-preview.md`.

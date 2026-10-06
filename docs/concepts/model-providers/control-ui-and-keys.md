---
summary: "Configuring providers from Settings -> Models, plugin-owned provider behavior, and API key rotation."
read_when:
  - You are adding or replacing provider keys in the Control UI
  - You want to know what provider plugins own
  - You are configuring multiple API keys or rotation
title: "Control UI and API keys"
---

## Configure providers in the Control UI

Open **Settings → Models**, then **Add provider**. Search the template library or
choose **Custom provider**, which stays first. A template can initialize multiple
providers. Each provider has a stable internal ID and an editable display name;
names must be unique after trimming spaces and ignoring letter case.

Confirming a template opens one editor with the name, Base URL, API format, API
key, and model list. Templates only prefill ordinary configuration. After saving,
the runtime reads the saved `models.providers` entry and its complete model list.
A deleted model stays deleted until you explicitly fetch it again.

All changes stay in the draft until **Save**. **Fetch models** uses the current
unsaved URL, API format, key, and request settings. Providers that need a key wait
until you enter one; no-key HTTP endpoints can fetch immediately. Discovery
reports unsupported model-list endpoints, rejected credentials, timeouts, and
empty results so you can correct the settings or add models manually.

You can add, edit, and delete every model in the same list. Editing a discovered
model makes it manually maintained. A later fetch replaces the untouched
discovered part and preserves manual rows; manual rows win duplicates at the same
effective Base URL and model ID. A failed fetch preserves the draft list. Changing
or deleting an ID referenced by defaults, fallbacks, or other settings is blocked
and lists the reference locations to update first.

Keys are hidden by default. A blank key field keeps the current key; the explicit
**Clear the saved API key when saving** action removes it. No-key HTTP endpoints
may leave the field empty. The page and `openclaw models auth paste-api-key` use
the same credential writer: key material stays in the auth store, and configured
providers reference the saved profile. Environment-provided keys remain managed
by the Gateway process environment.

Configuration and credential saves report separate outcomes. If settings save
but the key save fails, the editor keeps the key draft for retry. Canceling the
editor does not write configuration or credentials. Concurrent changes are
reported for review before retrying.

Model access supports API keys and no-key HTTP endpoints. External CLI/app-server
runners also require an explicitly prepared API key. Model subscription login,
OAuth, device codes, and native account fallback are unavailable. Channel and MCP
authentication follow their own contracts.

Provider controls load independently of usage and local costs. **Test
connection** sends a real inference request and reports latency or an
authentication, rate-limit, billing, timeout, or response error. A probe may
consume a small number of tokens.

The **Defaults** card manages the primary model, utility model, first fallback, thinking level, and Fast mode from the configured model catalog. Changes save automatically to the existing `agents.defaults` settings. For the utility model, **Auto** leaves the setting unset and **Disabled** stores an empty string to turn utility routing off.

The fallback selector edits the first model in the ordered fallback chain. Replacing it preserves any later fallbacks already configured; selecting **No fallback model** clears the chain. Use `openclaw models fallbacks` to manage the full ordered list.

## Plugin-owned provider behavior

Most provider-specific logic lives in provider plugins (`registerProvider(...)`) while OpenClaw keeps the generic inference loop. Plugins own onboarding, model catalogs, auth env-var mapping, transport/config normalization, tool-schema cleanup, failover classification, API key selection, usage reporting, thinking/reasoning profiles, and more.

The full list of provider-SDK hooks and bundled-plugin examples lives in [Provider plugins](/plugins/sdk-provider-plugins). A provider that needs a totally custom request executor is a separate, deeper extension surface.

<Note>
Provider-owned runner behavior lives on explicit provider hooks such as replay policy, tool-schema normalization, stream wrapping, and transport/request helpers. The legacy `ProviderPlugin.capabilities` static bag is compatibility-only and is no longer read by shared runner logic.
</Note>

## API key rotation

<AccordionGroup>
  <Accordion title="Key sources and priority">
    Configure multiple keys via:

    - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single live override, highest priority)
    - `<PROVIDER>_API_KEYS` (comma or semicolon list)
    - `<PROVIDER>_API_KEY` (primary key)
    - `<PROVIDER>_API_KEY_*` (numbered list, e.g. `<PROVIDER>_API_KEY_1`)

    For Google providers, `GOOGLE_API_KEY` is also included as fallback. Key selection order preserves priority and deduplicates values.

  </Accordion>
  <Accordion title="When rotation kicks in">
    - Requests are retried with the next key only on rate-limit responses (for example `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, or periodic usage-limit messages).
    - Non-rate-limit failures fail immediately; no key rotation is attempted.
    - When all candidate keys fail, the final error is returned from the last attempt.

  </Accordion>
</AccordionGroup>

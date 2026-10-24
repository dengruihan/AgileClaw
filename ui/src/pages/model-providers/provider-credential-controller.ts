import type { ModelsAuthInspectApiKeyResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";

type CredentialScope = {
  client: GatewayBrowserClient | null;
  agentId: string;
  provider: string;
  baseHash: string | undefined;
  revision: number | undefined;
  enabled: boolean;
};

/** Keeps editable secret bytes local to the selected provider, outside shared config state. */
export class ProviderCredentialController {
  value = "";
  revealed = false;
  loading = false;
  error: string | null = null;
  source: ModelsAuthInspectApiKeyResult["source"] = "none";
  private original = "";
  private scope: CredentialScope | null = null;
  private inspectedHash: string | undefined;
  private inspectedRevision: number | undefined;
  private generation = 0;

  constructor(private readonly update: () => void) {}

  get dirty() {
    return this.value.trim() !== this.original;
  }

  sync(scope: CredentialScope) {
    if (
      this.scope?.client !== scope.client ||
      this.scope.agentId !== scope.agentId ||
      this.scope.provider !== scope.provider ||
      this.scope.enabled !== scope.enabled
    ) {
      this.clear();
    }
    this.scope = scope;
    if (
      scope.enabled &&
      scope.client &&
      scope.baseHash &&
      !this.loading &&
      !this.dirty &&
      (scope.baseHash !== this.inspectedHash || scope.revision !== this.inspectedRevision)
    ) {
      void this.load(scope);
    }
  }

  clear() {
    this.generation += 1;
    this.value = this.original = "";
    this.revealed = this.loading = false;
    this.error = null;
    this.source = "none";
    this.inspectedHash = undefined;
    this.inspectedRevision = undefined;
    this.scope = null;
  }

  reset() {
    this.value = this.original;
    this.revealed = false;
    this.update();
  }

  saved(value: string) {
    this.value = this.original = value.trim();
    this.revealed = false;
    this.source = value ? "profile" : "none";
    this.error = null;
    this.inspectedHash = this.scope?.baseHash;
    this.inspectedRevision = this.scope?.revision;
    this.update();
  }

  private async load(scope: CredentialScope) {
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.inspectedHash = scope.baseHash;
    this.inspectedRevision = scope.revision;
    const current = () =>
      this.generation === generation &&
      this.scope?.client === scope.client &&
      this.scope?.baseHash === scope.baseHash &&
      this.scope?.revision === scope.revision;
    try {
      const result = await scope.client!.request<ModelsAuthInspectApiKeyResult>(
        "models.authInspectApiKey",
        {
          provider: scope.provider,
          agentId: scope.agentId,
          baseHash: scope.baseHash,
          reveal: true,
        },
      );
      if (current()) {
        this.value = this.original = result.key ?? "";
        this.source = result.source;
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.generation === generation) {
        this.loading = false;
        this.update();
      }
    }
  }
}

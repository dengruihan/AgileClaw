import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { mergeProbeResults, modelProviderErrorMessage } from "./config-mutation.ts";

type ModelProbeControllerOptions = {
  getAgentEpoch: () => number;
  getAgentId: () => string;
  getClient: () => GatewayBrowserClient | null;
  getClientEpoch: () => number;
  canMutate: () => boolean;
  isBusy: (key: string) => boolean;
  setBusy: (key: string, value: boolean) => void;
  setProbeResult: (cardId: string, result: ModelsProbeResult | null) => void;
  setProbeError: (cardId: string, message: string) => void;
  clearMessage: (cardId: string) => void;
  isCurrentClient: (client: GatewayBrowserClient, epoch: number) => boolean;
};

export class ModelProbeController {
  private probeEpochs = new Map<string, number>();

  constructor(private readonly options: ModelProbeControllerOptions) {}

  resetProbes(): void {
    this.probeEpochs = new Map();
  }

  clearProbe(cardId: string): void {
    this.probeEpochs.set(cardId, (this.probeEpochs.get(cardId) ?? 0) + 1);
    this.options.setBusy("probe:" + cardId, false);
    this.options.setProbeResult(cardId, null);
    this.options.clearMessage(cardId);
  }

  clearProviderProbes(provider: string): void {
    for (const id of this.probeEpochs.keys()) {
      if (id === provider || id.startsWith(provider + "/")) {
        this.clearProbe(id);
      }
    }
  }

  async probe(cardId: string, providers: string[], modelId?: string) {
    const client = this.options.getClient();
    const key = `probe:${cardId}`;
    if (!client || !this.options.canMutate() || this.options.isBusy(key)) {
      return;
    }
    const clientEpoch = this.options.getClientEpoch();
    const agentId = this.options.getAgentId();
    const agentEpoch = this.options.getAgentEpoch();
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () =>
      this.isCurrentScope(client, clientEpoch, agentEpoch, agentId) &&
      this.probeEpochs.get(cardId) === probeEpoch;
    this.options.setBusy(key, true);
    this.options.clearMessage(cardId);
    this.options.setProbeResult(cardId, null);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        if (!ownsProbe()) {
          return;
        }
        results.push(
          await client.request<ModelsProbeResult>("models.probe", {
            provider,
            agentId,
            ...(modelId ? { modelId } : {}),
          }),
        );
      }
      if (ownsProbe()) {
        this.options.setProbeResult(cardId, mergeProbeResults(cardId, results));
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      this.options.setProbeError(cardId, modelProviderErrorMessage(error));
    } finally {
      if (ownsProbe()) {
        this.options.setBusy(key, false);
      }
    }
  }

  private isCurrentScope(
    client: GatewayBrowserClient,
    clientEpoch: number,
    agentEpoch: number,
    agentId: string,
  ): boolean {
    return (
      this.options.isCurrentClient(client, clientEpoch) &&
      this.options.getAgentEpoch() === agentEpoch &&
      this.options.getAgentId() === agentId
    );
  }
}

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ThemeCatalogEntry } from "../../../packages/gateway-protocol/src/theme.js";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";
import {
  getUserPreferences,
  setUserPreferences,
} from "../../state/user-preferences.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { themeHandlers } from "./themes.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const { pluginThemes } = vi.hoisted(() => ({ pluginThemes: [] as ThemeCatalogEntry[] }));
// mock-isolation: plugin theme entries stay an empty fixture list.
vi.mock("../../plugins/theme-catalog.js", () => ({ listPluginThemes: () => pluginThemes }));

let state: OpenClawTestState;
let requesterProfileId: string;

beforeEach(async () => {
  pluginThemes.length = 0;
  state = await createOpenClawTestState({ layout: "state-only", prefix: "themes-pet-" });
  requesterProfileId = ensureProfileForEmail("requester@example.test").id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

function client(profileId?: string): GatewayClient {
  return {
    connId: "requester-browser",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.write"],
      client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, version: "test", platform: "test", mode: "ui" },
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

async function invoke(
  method: string,
  params: Record<string, unknown> = {},
  options: Partial<Omit<GatewayRequestHandlerOptions, "context">> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const { context, ...requestOptions } = options;
  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  const handler = expectDefined(themeHandlers[method], "theme handler");
  await handler({
    req: { type: "req", id: "theme-request", method, params },
    params,
    client: client(requesterProfileId),
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => ({}), ...context },
    ...requestOptions,
  } as GatewayRequestHandlerOptions);
  return expectDefined(result, "theme RPC response");
}

describe("theme RPC pet retirement", () => {
  it("keeps saved themes selected after pet metadata is retired", async () => {
    const definition = createThemeDefinitionFixture({ avatarHat: "crown" });
    for (const critters of [[], ["penguin"]]) {
      const stored = {
        "ui.theme": "user/legacy",
        "ui.themeDefinition.legacy": { ...definition, critters },
      };
      expect(setUserPreferences(requesterProfileId, stored).ok).toBe(true);
      const saved = getUserPreferences(requesterProfileId);
      const result = await invoke("themes.get");
      expect(result).toMatchObject({
        ok: true,
        payload: { current: { id: "user/legacy" }, definition },
      });
      expect(result.payload).not.toHaveProperty("definition.critters");
      expect(getUserPreferences(requesterProfileId)).toEqual(saved);
      const imported = await invoke("themes.import", {
        id: "restored",
        definition: { ...definition, critters },
        apply: true,
      });
      expect(imported).toMatchObject({
        ok: true,
        payload: { current: { id: "user/restored" }, definition },
      });
      expect(getUserPreferences(requesterProfileId)["ui.themeDefinition.restored"]).toEqual(
        definition,
      );
    }
  });
});

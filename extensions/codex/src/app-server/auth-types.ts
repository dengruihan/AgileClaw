import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { CodexLoginAccountParams } from "./protocol.js";

export type CodexAppServerPreparedAuthProfileSnapshot = {
  loginParams: Extract<CodexLoginAccountParams, { type: "apiKey" }>;
  secretFreeCacheKey: string;
};

export type CodexAppServerPreparedAuth =
  | { kind: "api-key"; apiKey: string }
  | {
      kind: "profile";
      profileId: string;
      store: AuthProfileStore;
      snapshot?: CodexAppServerPreparedAuthProfileSnapshot;
    };

export type CodexAppServerResolvedPreparedAuth =
  | Extract<CodexAppServerPreparedAuth, { kind: "api-key" }>
  | (Extract<CodexAppServerPreparedAuth, { kind: "profile" }> & {
      snapshot: CodexAppServerPreparedAuthProfileSnapshot;
    });

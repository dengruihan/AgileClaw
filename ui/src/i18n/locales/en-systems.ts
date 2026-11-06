import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Machine monitoring copy for the dashboards workspace. The standalone Systems
// page is gone; these strings cover the monitoring region only.
const enSystems = {
  systems: {
    title: "Systems",
    loading: "Loading machines…",
    empty: "No machines are available to this account.",
    offlineGateway: "Gateway disconnected. Reconnect to refresh machines.",
    refresh: "Refresh machines",
    online: "Online",
    offline: "Offline",
    host: "Gateway host",
    worker: "Worker",
    node: "Paired node",
    load: "Load (1 min)",
    cpuCount: "{count} cores",
    memory: "Memory used",
    disk: "Disk available",
    sampled: "Sampled {time}",
    lastKnown: "Last reported {time}",
    collectingHistory: "Collecting history…",
    noTelemetry: "This machine has not reported resource statistics.",
    statuses: { starting: "Starting", stopping: "Stopping", error: "Error" },
    errors: "Some machine information could not be refreshed.",
  },
} satisfies TranslationMap;

export const registerSystemsEnglish = Object.assign(() => Object.assign(en, enSystems), {
  catalog: enSystems,
});

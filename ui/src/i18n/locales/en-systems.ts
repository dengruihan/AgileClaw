import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Copy for the System monitoring preset the dashboards marketplace installs:
// its region, its vitals, and the measurements its preset card presents.
const enSystems = {
  systems: {
    title: "System monitoring",
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
    preset: {
      name: "System monitoring",
      description:
        "Live resource measurements for every machine this Gateway reports, refreshed while the preset is installed.",
    },
    measurements: {
      load: {
        label: "CPU load",
        description: "1-minute load average compared with the machine's core count.",
      },
      memory: {
        label: "Memory used",
        description: "Used memory against the total the machine reports.",
      },
      disk: {
        label: "Disk available",
        description: "Free space on each volume the machine reports.",
      },
    },
  },
} satisfies TranslationMap;

export const registerSystemsEnglish = Object.assign(() => Object.assign(en, enSystems), {
  catalog: enSystems,
});

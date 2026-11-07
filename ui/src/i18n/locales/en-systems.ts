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
    panelLibrary: {
      trigger: "Panels",
      triggerHint: "Choose which machine panels to show",
      title: "Machine panels",
      description:
        "Choose which resource panels appear for every machine. This browser remembers your selection; no Gateway settings change.",
      close: "Close panel library",
      done: "Done",
      showAll: "Show all panels",
      selected: "{count} of {total} panels shown",
    },
    panelCatalog: {
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
    noPanels: {
      title: "No machine panels selected",
      description: "Choose the resource panels you want to see for each machine.",
      action: "Open panel library",
    },
  },
} satisfies TranslationMap;

export const registerSystemsEnglish = Object.assign(() => Object.assign(en, enSystems), {
  catalog: enSystems,
});

/**
 * Lightweight Amazon Bedrock setup entry. It exposes auth detection and config
 * migration hooks without loading runtime streaming or AWS discovery code.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "amazon-bedrock",
  name: "Amazon Bedrock Setup",
  description: "Lightweight Amazon Bedrock setup hooks",
  register(api) {
    api.registerProvider({
      id: "amazon-bedrock",
      label: "Amazon Bedrock",
      auth: [],
    });
  },
});

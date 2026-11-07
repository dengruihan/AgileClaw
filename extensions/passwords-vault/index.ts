import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createVaultSaveLoginTool } from "./src/vault-save-login-tool.js";

export default definePluginEntry({
  id: "passwords-vault",
  name: "Passwords vault",
  description:
    "Agent save access to the built-in personal password vault through the vault_save_login tool.",
  register(api) {
    api.registerTool(() => createVaultSaveLoginTool(), { name: "vault_save_login" });
  },
});

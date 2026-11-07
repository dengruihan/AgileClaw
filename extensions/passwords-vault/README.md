# Passwords vault

Expose the built-in personal password vault's agent save tool. The
`vault_save_login` tool lets an agent save a website login directly into the
vault: the site is required, and account, password, notes, and label are
optional — blank fields are stored blank for the user to complete later in
**Settings → Passwords**.

No approval flow runs. Saves work while the vault is locked: the values are
sealed to a write-only public key and migrate into the passphrase-protected
format at the next unlock, so nothing is ever stored in plaintext. The tool
cannot list, reveal, update, or delete entries, and its result never contains
the saved password or notes.

The vault itself is core-owned; see the
[Password vault](https://docs.openclaw.ai/gateway/passwords-vault) guide for
the security model, permissions, and audit behavior.

---
summary: "Personal website password vault: encrypted CRUD, master passphrase, scopes, audit, and backup behavior"
read_when:
  - Saving, editing, revealing, or copying website passwords in the Control UI
  - Understanding how the password vault differs from API secrets and environment values
  - Reviewing vault permissions, audit records, retention, or backup behavior
title: "Password vault"
sidebarTitle: "Password vault"
---

The password vault stores personal website logins: the site, account, password, and notes. It is separate from [Secrets](/gateway/secrets), which holds API credentials and Gateway environment values.

<Warning>
The vault uses a master passphrase. If you forget it, the encrypted passwords and notes cannot be recovered. There is no reset, recovery code, or team key escrow in this release.
</Warning>

## What the vault stores

Each entry is one account on one website:

| Field                     | Stored form     | Notes                                                             |
| ------------------------- | --------------- | ----------------------------------------------------------------- |
| `itemRef`                 | Plaintext       | Opaque random identifier. Never derived from the site or account. |
| Scheme, host, port        | Plaintext       | Exact origin. Paths, query strings, and fragments are rejected.   |
| Site name, account, label | Plaintext       | Account names are visible to operators who can list the vault.    |
| Password                  | Ciphertext only | AES-256-GCM with authenticated metadata.                          |
| Notes                     | Ciphertext only | Encrypted even when empty.                                        |
| Revision and timestamps   | Plaintext       | Optimistic concurrency, last change, last use.                    |
| Deleted marker            | Plaintext       | Soft-deleted entries remain restorable for 7 days.                |

The vault never adds a plaintext password or notes column. The `secret_store_entries` table is not modified or reused.

## Security model

- A random 32-byte data encryption key (DEK) protects the vault. Each field is encrypted with a key derived with HKDF-SHA256 from the DEK and the entry reference, using AES-256-GCM.
- The DEK is wrapped by a key encryption key derived from the master passphrase with `scrypt` (`N=32768`, `r=8`, `p=1`, 16-byte salt). The wrap uses AES-256-GCM and stores a key check so a wrong passphrase is distinguishable from corrupted data.
- The DEK exists only in a dedicated vault worker thread. The Gateway main thread and agent/model processes never receive it. Locking or an auto-lock timeout terminates the worker, which zeroizes the key material.
- Authenticated associated data binds the entry reference, owner, exact origin, revision, key identity, and field name. Moving ciphertext to another entry, origin, or revision makes decryption fail.
- The vault starts locked after a Gateway restart. It auto-locks after the configured idle interval (default five minutes).
- Five consecutive wrong passphrases trigger a 30-second lockout. Further groups of five back off to five minutes, then one hour. Attempts and the timeout are persisted, so a restart does not clear them.
- No agent tool is registered for the vault. Agent/model context, transcripts, and logs never include passwords or notes.
- `operator.admin` does not imply `operator.vault.reveal`. Unlock, reveal, and copy need that explicit scope on the connection.
- Audit records contain actions, item references, and timestamps. They never contain passwords, notes, or account names.

## Use the vault

1. Open **Settings → Passwords**.
2. Create the vault with a master passphrase and an auto-lock interval. The passphrase is required and cannot be recovered later.
3. Add an entry with the website URL, site name, account, password, and optional notes. The password generator uses the operating system CSPRNG.
4. Use **Show** to reveal one password for 30 seconds, or **Copy** to copy it. The clipboard is cleared after 30 seconds where the browser permits it.
5. Edit or delete entries individually. Editing keeps existing notes unless you explicitly choose **Replace notes** or **Clear notes**; a manage-only client can edit the site or account without losing notes it cannot read. A deleted entry can be restored for 7 days; **Delete permanently** removes it immediately.

The list is grouped by website and supports multiple accounts per site. Search covers site names, hosts, accounts, and labels. The list never reads ciphertext.

## Permissions

The vault adds two operator scopes:

| Scope                   | Allows                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `operator.vault`        | Status, initialize, list, create, update, soft delete, restore, permanent delete, auto-lock settings, audit list |
| `operator.vault.reveal` | Unlock, reveal, and copy                                                                                         |

Grant the vault scopes explicitly in an operator role or device authorization. CLI and operator clients do not receive them by default. A client with only `operator.admin` can manage entries but cannot unlock or see values; `operator.vault.reveal` must be granted explicitly.

Gateway methods are `vault.status`, `vault.initialize`, `vault.unlock`, `vault.lock`, `vault.list`, `vault.create`, `vault.update`, `vault.delete`, `vault.restore`, `vault.purge`, `vault.reveal`, `vault.copy`, `vault.generate`, `vault.setAutoLock`, and `vault.audit.list`.

## Retention and backups

- Soft-deleted entries are hard-deleted after 7 days. Restore rejects an expired entry, and the vault worker sweeps expired rows at startup and on its scheduled maintenance interval, even when nobody lists or creates entries.
- Database backups contain only ciphertext. A backup without the master passphrase cannot decrypt passwords or notes. This is intentional: keep the passphrase separately if you need to restore a backup.
- Git push backups omit the vault tables through the credential-table redaction policy, along with `secret_store_entries`.
- Restoring a database does not restore an unlocked state. The vault starts locked and the worker holds no key after restart.

## What this release does not do

- No team or shared vault. The owner is the local personal profile.
- No TOTP seeds, plaintext export, CSV import, or automatic migration from environment values.
- No automatic browser fill or agent access. Those are separate follow-up work with their own approval and origin-matching design.
- No OS-keychain-only wrapping. Only the passphrase wrap is supported, so headless and cross-platform restore behavior stays predictable.

## Related

- [Secrets management](/gateway/secrets)
- [Shared secret store and egress proxy](/gateway/secrets/secret-store-and-egress)
- [Backups](/install/backups)
- [Database schemas](/reference/database-schemas)

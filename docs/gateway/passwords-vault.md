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
- Agent fill is a separate, per-request flow that uses an opaque `itemRef`; it never exposes a vault read verb to the model. See [Agent fill](#agent-fill).
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

| Scope                   | Allows                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.vault`        | Status, initialize, list, create, update, soft delete, restore, permanent delete, auto-lock settings, audit list, agent fill preview/execute |
| `operator.vault.reveal` | Unlock, reveal, and copy                                                                                                                     |

Grant the vault scopes explicitly in an operator role or device authorization. CLI and operator clients do not receive them by default. A client with only `operator.admin` can manage entries but cannot unlock or see values; `operator.vault.reveal` must be granted explicitly.

Gateway methods are `vault.status`, `vault.initialize`, `vault.unlock`, `vault.lock`, `vault.list`, `vault.create`, `vault.update`, `vault.delete`, `vault.restore`, `vault.purge`, `vault.reveal`, `vault.copy`, `vault.generate`, `vault.setAutoLock`, `vault.audit.list`, `vault.fill.approval.request`, `vault.fill.preview`, and `vault.fill.execute`.

## Agent fill

An agent can ask to use one saved login without receiving the password. This is a per-use flow, not a standing vault grant:

1. The model calls the `browser_login` tool with an opaque `itemRef`. It cannot list, reveal, or read entries.
2. The local browser tool observes the active tab's exact origin, document, and login fields. The model never supplies the origin.
3. The vault checks the observation against the entry. The scheme, host, and port must match exactly; IDN hosts compare in A-label form. Subdomains, cross-origin password iframes, and non-http(s) pages are rejected.
4. The operator sees a plugin approval card with the agent, origin, profile, saved site/account, and the agent's reason. The only offered decision is **allow once** or **deny**. There is no standing grant, background use, or unattended fill.
5. After approval the tool re-observes the tab. A navigation, document replacement, field change, or password revision change invalidates the request.
6. The vault decrypts once, the trusted in-process browser fill dispatch inserts the username and password, and the value is dropped. `submit` defaults to `false`; setting it to `true` requests a second "Submit login form" approval after the fill, and never presses Enter on the fill approval alone.

Results are explicit and value-free: `filled`, `needs_approval`, `needs_human`, `denied`, `origin_mismatch`, `subdomain_mismatch`, `insecure_origin`, `iframe_denied`, `document_changed`, `revision_mismatch`, `not_found`, `expired`, `replayed`, `vault_locked`, or `unavailable`. The agent never receives the password, account name in the tool result, or fill material.

When `browser_login` observes a human gate (CAPTCHA, verification code, or a page without a fillable login field), it returns `needs_human` and asks the browser owner to pause that tab. The Control UI shows the request; the human claims the tab, finishes the challenge, and hands it back with revalidated origin, document, and login state. See [Browser human takeover](/tools/browser/human-takeover). CAPTCHA/2FA support never stores TOTP seeds or calls a third-party solving service.

### Trust boundaries

- Agent fill runs only on the local managed or shared Chromium controlled by this Gateway. Browser nodes, sandbox targets, remote CDP URLs, and existing-session profiles are rejected.
- The password exists only in the vault worker, the broker's one-time material, and the trusted in-process browser fill dispatch used to insert it. It is never written to a Gateway RPC/WebSocket response, tool request/result, model context, transcript, Gateway log, or audit record.
- While a fill session owns the tab, `act:evaluate`, `act:wait --fn`, screenshots, and every agent click/press/type/fill/select/drag/batch interaction are blocked; text-bearing tool results pass through a broker-owned full-mask scrub that runs even when `logging.redact` is `off`. Submission is available only through the separately approved `browser_login` submit flow. The session persists until the tab navigates, closes, or the approved submit clears the field; it never expires by wall-clock time.
- OpenClaw cannot isolate the password from page JavaScript or another CDP client attached to the same browser. A page script can read its own input value, and any co-attached CDP client can evaluate in the page. The fill broker reduces OpenClaw's own leak surfaces; it is not a same-machine isolation boundary. Treat a browser profile as trusted for the logins it holds.
- Document identity comes from the browser's CDP loader id. If the browser cannot expose one, the fill fails closed (`document_identity_unavailable`) instead of using a URL-derived token, so a same-URL reload invalidates the approval.
- A human takeover is tab-scoped and separate from the fill approval. While the human owns the tab, agent mutations, fills, screenshots, and snapshots are blocked; the panel's sensitive input route never reaches the model or transcript. Handback revalidates the origin and document, so a challenge that redirects to another host cannot be mistaken for the approved login page.
- Passwords never enter `secret_store_entries`. Fill approvals use the existing operator approval store, and vault audit rows contain only the action, item reference, status, and reason code.

### Configuration and auditing

`vault.fill.preview` and `vault.fill.execute` require `operator.vault`. `vault.fill.execute` additionally requires a live agent runtime identity and a matching one-time approval; ordinary operator clients cannot redeem fill material. Fill attempts are audited as action `fill` with a status and reason code, never a value. Editing an entry's password, origin, or account bumps its revision and invalidates pending fill requests for that entry.

## Retention and backups

- Soft-deleted entries are hard-deleted after 7 days. Restore rejects an expired entry, and the vault worker sweeps expired rows at startup and on its scheduled maintenance interval, even when nobody lists or creates entries.
- Database backups contain only ciphertext. A backup without the master passphrase cannot decrypt passwords or notes. This is intentional: keep the passphrase separately if you need to restore a backup.
- Git push backups omit the vault tables through the credential-table redaction policy, along with `secret_store_entries`.
- Restoring a database does not restore an unlocked state. The vault starts locked and the worker holds no key after restart.
- Updating from the first vault release upgrades the value-free audit table in place during shared-state schema admission. Existing audit rows, their sequence, and the audit index are retained; rolling back to that build needs the verified pre-update backup. See the [versioning contract](/reference/database-schemas/versioning).

## What this release does not do

- No team or shared vault. The owner is the local personal profile.
- No TOTP seeds, plaintext export, CSV import, or automatic migration from environment values.
- Agent fill is limited to a one-time, exact-origin, locally approved request. There is no unattended or background fill, no standing grant, no team sharing, and no remote browser-node fill.
- No OS-keychain-only wrapping. Only the passphrase wrap is supported, so headless and cross-platform restore behavior stays predictable.

## Related

- [Secrets management](/gateway/secrets)
- [Shared secret store and egress proxy](/gateway/secrets/secret-store-and-egress)
- [Backups](/install/backups)
- [Database schemas](/reference/database-schemas)

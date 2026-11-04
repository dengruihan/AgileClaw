---
summary: "Tab-scoped human takeover for CAPTCHA, 2FA, and manual sign-in while the agent is paused"
read_when:
  - An agent asks for help with a CAPTCHA or two-factor prompt
  - You need to type a password or verification code without exposing it to the agent
  - A browser tab shows a "needs your input" or "you control this tab" banner
title: "Browser human takeover"
sidebarTitle: "Human takeover"
---

Human takeover pauses agent interaction with **one browser tab** long enough for you to finish a login challenge. The rest of the browser and other tabs stay available to the agent.

It covers CAPTCHA pages, two-factor or verification-code prompts, consent screens, and manual sign-in steps that the agent cannot complete safely. It does not solve CAPTCHAs, store TOTP seeds, or send the page to a third-party service.

## Ownership states

| State          | What the panel shows                              | Agent behavior                                                                                                                                           |
| -------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent-owned    | "Agent owns this tab" with **Take over this tab** | Normal browser actions.                                                                                                                                  |
| Requested      | "Agent paused: this tab needs your input"         | Agent actions on this tab return `needs_human` until you take over.                                                                                      |
| You control it | "You control this tab" with hand-back and cancel  | Every agent action on this tab is blocked, including PDF, screenshots, downloads, upload/dialog, emulation, focus, and close; other tabs are unaffected. |

An agent asks for takeover when `browser_login` observes that the page no longer has a fillable login field, or when the page reports `needs_human` (CAPTCHA, verification code, unsupported document identity). You can also take over any tab yourself before the agent asks.

The Control UI claims the lease with a one-time capability. Agent tool calls never receive that capability, so an agent run triggered from the same Gateway connection still cannot act through your takeover.

## Workflow

1. Start the task normally, for example with `browser_login` and an opaque `itemRef`.
2. The page shows a CAPTCHA, a verification-code prompt, or another human gate. The agent's result is `needs_human`.
3. Open the browser panel. The tab banner names the owner and offers **Take over this tab**.
4. Take over, finish the challenge in the page, and enter any sensitive value through the panel.
5. Choose **Hand back to agent**. OpenClaw requires the claim-time and handback-time origin, CDP document identity, and cookie-name login fingerprints. If any baseline is unavailable it keeps human control and returns a value-free `baseline_unavailable` or `login_state_unavailable` reason. The agent must re-observe the page after handback, so a changed origin or document is visible to it instead of being mistaken for the approved page.
6. Choose **Cancel takeover** to return the tab without the handback checks, for example when the challenge cannot be completed.

The panel polls the tab's ownership while it is open, so an agent-requested takeover appears without a chat round trip.

## Sensitive input

While you control a tab, text and pasted values from the panel use a dedicated sensitive-input route instead of the ordinary agent `act` path:

- The value is not placed in a model request, tool result, transcript, tool-call event, or Gateway log. Error responses are deliberately opaque and never echo the request body.
- The browser owner arms masking before insertion, using the same scrub owner as vault fill. Agent screenshots, labeled snapshots, and text-bearing read results are blocked or masked until the document is replaced or the tab closes.
- The value exists only for insertion and process-local masking. OpenClaw does not write it to the vault, an audit row, or browser history.
- **Hand back to agent** keeps masking if the sensitive field is still in the same document. **Cancel takeover** also does not clear it: cancel only returns ownership, and clearing masking while the same sensitive document remains would be unsafe. Navigate to a different document (the browser owner retires masking when the CDP document loader id changes), close the tab, or complete a positively confirmed managed-browser stop to drop protection. Same-document/hash navigation and downloads keep masking because the original field may still hold the value. An unreachable probe, an attach-only/remote detach, an unverified managed stop, a stopped screencast, a lost CDP session, or a profile lifecycle transition does not prove the document is gone, so masking and ownership stay in place.

Do not type secrets into the chat composer or an agent `type`/`fill` action. Those values are model-visible and persisted.

## Lease lifecycle

- A request waits for a human claim for 2 minutes. If nobody claims it, the tab returns to the agent.
- An active takeover has a 5-minute inactivity window, renewed by human clicks, keys, navigation, and sensitive input. A 30-minute absolute cap bounds a stuck lease.
- **Locking** a tab is the active takeover state: the agent is blocked until you hand back or cancel.
- Closing the tab, a positively confirmed managed-browser stop, a successful profile reset, or restarting the Gateway clears the lease. A transient unreachable probe, attach-only/remote detach, or unverified managed stop keeps it because the document may still be alive. Closing the Gateway connection that claimed it also clears its leases.
- Navigation while you control the tab stays inside your lease. Handback then reports the new origin/document and whether the login fingerprint changed; it does not silently reuse the pre-takeover approval.
- A lease is keyed by the stable per-profile tab handle. The agent's fill approval is separately bound to the exact document and field, so handback alone never authorizes a new fill.

## Trust boundaries

- Human takeover runs only on the local managed browser profile on the Gateway host. Browser nodes, remote CDP endpoints, extension relays, and existing-session profiles are rejected. The sensitive input and lease routes are forced onto the Gateway host and never cross the node proxy.
- The lease itself contains only an opaque tab handle, profile, reason, timestamps, and a hashed capability. It never contains passwords, OTP values, session cookies, or TOTP seeds.
- Login-state revalidation reads cookie **names and scope**, never values, and hashes them. Handback also requires a claim-time origin and CDP document identity; if either baseline is missing, handback refuses rather than returning unverified control. Cancel remains the explicit unchecked exit.
- OpenClaw cannot isolate a typed value from the page's own JavaScript or another CDP client attached to the same browser. The sensitive route removes OpenClaw's own model, transcript, and log surfaces; treat the browser profile as trusted for the logins it holds.
- No TOTP seed storage, no automated CAPTCHA solving, and no third-party challenge service are part of this flow.

## Screenshots

Desktop, agent-owned tab before takeover:

<img src="/assets/browser-human-takeover/desktop-before.png" alt="Browser panel with the agent-owned banner and a Take over this tab button" />

Desktop, human control active:

<img src="/assets/browser-human-takeover/desktop-after.png" alt="Browser panel showing the human-controlled banner with Hand back and Cancel actions" />

Narrow viewport before and after takeover:

<img src="/assets/browser-human-takeover/narrow-before.png" alt="Narrow browser panel with the agent-owned takeover prompt wrapped above the page" />
<img src="/assets/browser-human-takeover/narrow-after.png" alt="Narrow browser panel showing human control with wrapped actions" />

## Related

- [Password vault → Agent fill](/gateway/passwords-vault#agent-fill)
- [Browser login](/tools/browser-login)
- [Browser agent tools](/tools/browser/agent-tools)

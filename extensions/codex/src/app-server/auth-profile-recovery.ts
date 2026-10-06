export class CodexAppServerAuthProfileUnavailableError extends Error {
  readonly code = "selected_auth_profile_unavailable";
}

export function formatCodexAuthProfileUnavailableMessage(profileId: string): string {
  const missing = `Codex app-server auth profile "${profileId}" was not found in the OpenClaw credential store. This is a local credential lookup failure.`;
  return `${missing} Configure and select an OpenAI API-key profile in Models settings, then retry.`;
}

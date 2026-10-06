export function parseGithubCopilotApiKey(value: string): { githubToken: string } {
  return { githubToken: value.trim() };
}

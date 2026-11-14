declare module "*security/opengrep/check-rule-metadata.mjs" {
  export function validateRuleMetadata(
    rules: Array<{ id: string; metadata?: Record<string, string> }>,
  ): string[];
}

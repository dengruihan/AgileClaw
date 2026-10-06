import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createBedrockAwsSdkConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        "amazon-bedrock": {
          auth: "api-key",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "anthropic-messages",
          models: [],
        },
      },
    },
    auth: {
      profiles: {
        "amazon-bedrock:default": {
          provider: "amazon-bedrock",
          mode: "aws-sdk",
        },
      },
    },
  };
}

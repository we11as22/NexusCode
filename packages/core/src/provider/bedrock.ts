import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createBedrockClient(config: ProviderConfig) {
  const bedrock = createAmazonBedrock({
    region: config.extra?.["region"] as string | undefined ?? process.env["AWS_REGION"] ?? "us-east-1",
    accessKeyId: config.extra?.["accessKeyId"] as string | undefined ?? process.env["AWS_ACCESS_KEY_ID"],
    secretAccessKey: config.extra?.["secretAccessKey"] as string | undefined ?? process.env["AWS_SECRET_ACCESS_KEY"],
    sessionToken: config.extra?.["sessionToken"] as string | undefined ?? process.env["AWS_SESSION_TOKEN"],
  })
  const model = bedrock(config.id)
  return new BaseLLMClient(model as any, "bedrock", config.id)
}

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { normalizeAwsRegion } from "./credential-identity.js"

export function createBedrockClient(config: ProviderConfig) {
  const region = normalizeAwsRegion(
    config.extra?.["region"] ??
      process.env["AWS_REGION"] ??
      "us-east-1",
  )
  const bedrock = createAmazonBedrock({
    region,
  })
  const model = bedrock(config.id)
  return new BaseLLMClient(model as any, "bedrock", config.id)
}

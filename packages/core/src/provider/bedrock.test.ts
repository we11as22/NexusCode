import { afterEach, describe, expect, it, vi } from "vitest"

const captured = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
}))

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock(options: Record<string, unknown>) {
    captured.options.push(options)
    return () => ({ specificationVersion: "v1" })
  },
}))

import { createBedrockClient } from "./bedrock.js"

describe("Bedrock credential isolation", () => {
  afterEach(() => {
    captured.options.length = 0
    vi.unstubAllEnvs()
  })

  it("passes only a validated region and leaves credentials to the AWS SDK chain", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-id")
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
    vi.stubEnv("AWS_SESSION_TOKEN", "ambient-session")

    createBedrockClient({
      provider: "bedrock",
      id: "amazon.nova-pro-v1:0",
      extra: {
        region: "us-west-2",
        accessKeyId: "inline-id",
        secretAccessKey: "inline-secret",
        sessionToken: "inline-session",
      },
    })

    expect(captured.options).toEqual([{ region: "us-west-2" }])
  })

  it("rejects a malicious region before constructing the SDK provider", () => {
    expect(() => createBedrockClient({
      provider: "bedrock",
      id: "amazon.nova-pro-v1:0",
      extra: { region: "us-east-1/../../evil" },
    })).toThrow(/Invalid AWS region/)
    expect(captured.options).toEqual([])
  })
})

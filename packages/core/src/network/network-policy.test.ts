import { describe, expect, it, vi } from "vitest"

import {
  NetworkPolicyError,
  authorizeNetworkRequest,
  isPublicNetworkAddress,
  type NetworkResolver,
} from "./network-policy.js"

function resolver(
  addresses: Array<{ address: string; family: 4 | 6 }>,
): NetworkResolver {
  return vi.fn(async () => addresses)
}

describe("network request authorization", () => {
  it("accepts the dedicated MCP purpose without weakening address policy", async () => {
    const resolve = resolver([
      { address: "93.184.216.34", family: 4 },
    ])

    await expect(authorizeNetworkRequest(
      { url: "https://mcp.example/rpc", purpose: "mcp" },
      { resolve },
    )).resolves.toMatchObject({
      url: "https://mcp.example/rpc",
      hostname: "mcp.example",
    })
    expect(resolve).toHaveBeenCalledWith("mcp.example")
  })

  it("authorizes http(s) only after every DNS answer is public", async () => {
    const resolve = resolver([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ])

    await expect(authorizeNetworkRequest(
      { url: "https://Example.COM:443/docs?q=1", purpose: "web_fetch" },
      { resolve },
    )).resolves.toEqual({
      url: "https://example.com/docs?q=1",
      hostname: "example.com",
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    })
    expect(resolve).toHaveBeenCalledWith("example.com")
  })

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file",
    "data:text/plain,secret",
    "javascript:alert(1)",
  ])("rejects non-HTTP protocol: %s", async (url) => {
    await expect(authorizeNetworkRequest(
      { url, purpose: "web_fetch" },
      { resolve: resolver([{ address: "93.184.216.34", family: 4 }]) },
    )).rejects.toMatchObject({
      name: "NetworkPolicyError",
      code: "unsupported_protocol",
    })
  })

  it.each([
    "https://user@example.com/",
    "https://user:password@example.com/",
  ])("rejects URL credentials: %s", async (url) => {
    await expect(authorizeNetworkRequest(
      { url, purpose: "web_fetch" },
      { resolve: resolver([{ address: "93.184.216.34", family: 4 }]) },
    )).rejects.toMatchObject({
      code: "url_credentials",
    })
  })

  it.each([
    "http://localhost/",
    "http://localhost./",
    "http://api.localhost/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://[::1]/",
  ])("rejects localhost and alternate loopback literals: %s", async (url) => {
    await expect(authorizeNetworkRequest(
      { url, purpose: "web_fetch" },
      { resolve: resolver([{ address: "93.184.216.34", family: 4 }]) },
    )).rejects.toBeInstanceOf(NetworkPolicyError)
  })

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "168.63.129.16",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "100::1",
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:4860:1:2:0:5efe:10.0.0.1",
  ])("classifies non-public address %s as blocked", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "::ffff:0:8.8.8.8",
    "64:ff9b::808:808",
    "2002:0808:0808::1",
  ])("classifies globally routable address %s as public", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true)
  })

  it("fails closed if one of several DNS answers is private", async () => {
    await expect(authorizeNetworkRequest(
      { url: "https://rebinding.example/", purpose: "web_fetch" },
      {
        resolve: resolver([
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ]),
      },
    )).rejects.toMatchObject({
      code: "blocked_address",
    })
  })

  it("fails closed on empty, malformed, or mismatched resolver output", async () => {
    for (const answers of [
      [],
      [{ address: "not-an-ip", family: 4 as const }],
      [{ address: "1.1.1.1", family: 6 as const }],
    ]) {
      await expect(authorizeNetworkRequest(
        { url: "https://example.com/", purpose: "web_search" },
        { resolve: resolver(answers) },
      )).rejects.toBeInstanceOf(NetworkPolicyError)
    }
  })

  it("does not invoke DNS for an IP literal", async () => {
    const resolve = resolver([{ address: "127.0.0.1", family: 4 }])
    await expect(authorizeNetworkRequest(
      { url: "https://93.184.216.34/", purpose: "web_fetch" },
      { resolve },
    )).resolves.toMatchObject({
      hostname: "93.184.216.34",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})

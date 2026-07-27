import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

import type {
  AuthorizedNetworkRequest,
  HostNetworkRequest,
  ResolvedNetworkAddress,
} from "../types.js"

export type NetworkPolicyErrorCode =
  | "invalid_url"
  | "invalid_purpose"
  | "unsupported_protocol"
  | "url_credentials"
  | "blocked_hostname"
  | "dns_failed"
  | "blocked_address"
  | "invalid_dns_result"

export class NetworkPolicyError extends Error {
  readonly code: NetworkPolicyErrorCode

  constructor(code: NetworkPolicyErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = "NetworkPolicyError"
    this.code = code
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      })
    }
  }
}

export type NetworkResolver = (
  hostname: string,
) => Promise<readonly ResolvedNetworkAddress[]>

export interface NetworkPolicyOptions {
  resolve?: NetworkResolver
}

const MAX_NETWORK_URL_CHARACTERS = 16 * 1024
const MAX_DNS_ADDRESSES = 64

const blockedV4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4")
}

const blockedV6 = new BlockList()
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6")
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  return withoutBrackets.toLowerCase().replace(/\.+$/, "")
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  const values = parts.map((part) => Number(part))
  if (values.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255
  )) {
    return null
  }
  return values as [number, number, number, number]
}

function ipv4FromGroups(high: number, low: number): string {
  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff,
  ].join(".")
}

/**
 * Expand a validated IPv6 literal into eight 16-bit groups. Dotted IPv4 tails
 * are normalized first so mapped/NAT64 addresses cannot bypass range checks.
 */
function expandIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%")
  if (zoneIndex !== -1) return null

  let normalized = address.toLowerCase()
  let ipv4Tail: number[] = []
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":")
    if (lastColon === -1) return null
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1))
    if (!ipv4) return null
    ipv4Tail = [
      (ipv4[0] << 8) | ipv4[1],
      (ipv4[2] << 8) | ipv4[3],
    ]
    normalized = normalized.slice(0, lastColon)
  }

  const doubleColon = normalized.indexOf("::")
  if (
    doubleColon !== -1 &&
    normalized.indexOf("::", doubleColon + 1) !== -1
  ) {
    return null
  }

  const head =
    doubleColon === -1
      ? normalized.split(":")
      : normalized.slice(0, doubleColon).split(":").filter(Boolean)
  const tail =
    doubleColon === -1
      ? []
      : normalized.slice(doubleColon + 2).split(":").filter(Boolean)
  const expectedHexGroups = 8 - ipv4Tail.length
  const omitted = expectedHexGroups - head.length - tail.length
  if (
    (doubleColon === -1 && omitted !== 0) ||
    (doubleColon !== -1 && omitted < 1)
  ) {
    return null
  }

  const groups = [
    ...head,
    ...Array.from({ length: omitted }, () => "0"),
    ...tail,
  ].map((part) => {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return Number.NaN
    return Number.parseInt(part, 16)
  })
  groups.push(...ipv4Tail)
  return groups.length === 8 && groups.every(Number.isInteger)
    ? groups
    : null
}

function embeddedIpv4(address: string): string | null {
  const groups = expandIpv6(address)
  if (!groups) return null

  const mappedOrCompatible =
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0 || groups[5] === 0xffff)
  if (mappedOrCompatible) {
    return ipv4FromGroups(groups[6]!, groups[7]!)
  }

  const ipv4Translated =
    groups.slice(0, 4).every((group) => group === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  if (ipv4Translated) {
    return ipv4FromGroups(groups[6]!, groups[7]!)
  }

  const nat64WellKnown =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  if (nat64WellKnown) {
    return ipv4FromGroups(groups[6]!, groups[7]!)
  }

  if (groups[0] === 0x2002) {
    return ipv4FromGroups(groups[1]!, groups[2]!)
  }

  const isatap =
    (groups[4] === 0 || groups[4] === 0x200) &&
    groups[5] === 0x5efe
  if (isatap) {
    return ipv4FromGroups(groups[6]!, groups[7]!)
  }

  return null
}

/**
 * True only for a syntactically valid, globally routable IP address.
 * Reserved, private, loopback, link-local, multicast, documentation and
 * unspecified ranges are rejected for both address families.
 */
export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    return !blockedV4.check(address, "ipv4")
  }
  if (family !== 6) return false

  const embedded = embeddedIpv4(address)
  if (embedded !== null) {
    return isPublicNetworkAddress(embedded)
  }
  return !blockedV6.check(address, "ipv6")
}

const defaultResolver: NetworkResolver = async (hostname) => {
  const answers = await lookup(hostname, {
    all: true,
    verbatim: true,
  })
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : []
  )
}

export async function authorizeNetworkRequest(
  request: HostNetworkRequest,
  options: NetworkPolicyOptions = {},
): Promise<AuthorizedNetworkRequest> {
  if (
    request.purpose !== "web_fetch" &&
    request.purpose !== "web_search" &&
    request.purpose !== "mcp" &&
    request.purpose !== "remote_session"
  ) {
    throw new NetworkPolicyError(
      "invalid_purpose",
      "Network request blocked: purpose is invalid.",
    )
  }
  if (
    typeof request.url !== "string" ||
    request.url.length > MAX_NETWORK_URL_CHARACTERS
  ) {
    throw new NetworkPolicyError(
      "invalid_url",
      `Network request blocked: URL exceeds ${MAX_NETWORK_URL_CHARACTERS} characters.`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch (error) {
    throw new NetworkPolicyError(
      "invalid_url",
      "Network request blocked: URL is invalid.",
      error,
    )
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkPolicyError(
      "unsupported_protocol",
      `Network request blocked: protocol ${parsed.protocol || "(missing)"} is not HTTP(S).`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new NetworkPolicyError(
      "url_credentials",
      "Network request blocked: credentials in URLs are not allowed.",
    )
  }

  parsed.hash = ""
  const hostname = normalizeHostname(parsed.hostname)
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new NetworkPolicyError(
      "blocked_hostname",
      "Network request blocked: localhost is not an allowed destination.",
    )
  }

  const literalFamily = isIP(hostname)
  let addresses: readonly ResolvedNetworkAddress[]
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{
      address: hostname,
      family: literalFamily,
    }]
  } else {
    try {
      addresses = await (options.resolve ?? defaultResolver)(hostname)
    } catch (error) {
      throw new NetworkPolicyError(
        "dns_failed",
        `Network request blocked: DNS resolution failed for ${hostname}.`,
        error,
      )
    }
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.length > MAX_DNS_ADDRESSES
  ) {
    throw new NetworkPolicyError(
      "invalid_dns_result",
      `Network request blocked: DNS returned an invalid address set for ${hostname}.`,
    )
  }

  const unique = new Map<string, ResolvedNetworkAddress>()
  for (const answer of addresses) {
    const actualFamily = isIP(answer.address)
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      actualFamily !== answer.family
    ) {
      throw new NetworkPolicyError(
        "invalid_dns_result",
        `Network request blocked: DNS returned an invalid address for ${hostname}.`,
      )
    }
    if (!isPublicNetworkAddress(answer.address)) {
      throw new NetworkPolicyError(
        "blocked_address",
        `Network request blocked: ${hostname} resolves to a non-public address.`,
      )
    }
    unique.set(`${answer.family}:${answer.address}`, {
      address: answer.address,
      family: answer.family,
    })
  }

  return {
    url: parsed.toString(),
    hostname,
    addresses: [...unique.values()],
  }
}

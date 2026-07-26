import { afterEach, describe, expect, it, vi } from "vitest"

import { NexusServerClient } from "./server-client.js"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NexusServerClient authorization", () => {
  it("requires a token before making requests", () => {
    expect(
      () =>
        new NexusServerClient({
          baseUrl: "http://127.0.0.1:4097",
          directory: process.cwd(),
          token: " ",
        }),
    ).toThrow(/token is required/i)
  })

  it("attaches the bearer token to every session request", async () => {
    const headers: Headers[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        headers.push(new Headers(init?.headers))
        const url = String(input)
        if (init?.method === "DELETE") {
          return new Response("", { status: 200 })
        }
        if (url.includes("/message")) {
          return Response.json([])
        }
        if (init?.method === "POST") {
          return Response.json({
            id: "session_test",
            cwd: process.cwd(),
            ts: 1,
            messageCount: 0,
          })
        }
        if (/\/session\/[^/?]+/.test(url)) {
          return Response.json({
            id: "session_test",
            cwd: process.cwd(),
            ts: 1,
            messageCount: 0,
          })
        }
        return Response.json([])
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    await client.listSessions()
    await client.createSession()
    await client.getSession("session_test")
    await client.getMessages("session_test")
    await client.deleteSession("session_test")

    expect(headers).toHaveLength(5)
    expect(
      headers.every(
        (value) => value.get("authorization") === "Bearer secret-token",
      ),
    ).toBe(true)
  })

  it("retains authorization when a stream reconnects", async () => {
    const headers: Headers[] = []
    let attempt = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        headers.push(new Headers(init?.headers))
        attempt++
        if (attempt === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection dropped"))
              },
            }),
            { status: 200, headers: { "x-nexus-run-id": "run_test" } },
          )
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
          { status: 200, headers: { "x-nexus-run-id": "run_test" } },
        )
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    for await (const _event of client.streamMessage(
      "session_test",
      "hello",
      "agent",
    )) {
      // Drain reconnect status events.
    }

    expect(headers).toHaveLength(2)
    expect(
      headers.every(
        (value) => value.get("authorization") === "Bearer secret-token",
      ),
    ).toBe(true)
  })

  it("retries an initial request with the same client-generated run id", async () => {
    const bodies: Array<Record<string, unknown>> = []
    let attempt = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        attempt++
        if (attempt === 1) throw new Error("socket closed before response headers")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
          {
            status: 200,
            headers: { "x-nexus-run-id": String(bodies[0]?.clientRunId) },
          },
        )
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    for await (const _event of client.streamMessage(
      "session_test",
      "hello exactly once",
      "agent",
    )) {
      // Drain request reconnect status events.
    }

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.clientRunId).toMatch(/^run_[a-f0-9]{32}$/)
    expect(bodies[1]).toMatchObject({
      clientRunId: bodies[0]?.clientRunId,
      content: "hello exactly once",
    })
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"

import { NexusServerClient } from "./server-client.js"

afterEach(() => {
  vi.useRealTimers()
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

  it("clears heartbeat timers after every received stream chunk", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `${JSON.stringify({ seq: 1, event: { type: "text_delta", delta: "one", messageId: "m1" } })}\n`,
            ))
            controller.enqueue(new TextEncoder().encode(
              `${JSON.stringify({ seq: 2, event: { type: "text_delta", delta: "two", messageId: "m1" } })}\n`,
            ))
            controller.close()
          },
        }),
        { status: 200, headers: { "x-nexus-run-id": "run_timer_test" } },
      )),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    const events = []
    for await (const event of client.streamMessage("session_test", "hello", "agent")) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("posts authenticated approval decisions to the exact run and part", async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ ok: true })
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    await client.respondToApproval(
      "session_test",
      "run_test",
      "part_test",
      { approved: false, whatToDoInstead: "use the read-only path" },
    )

    expect(requests).toEqual([{
      url: "http://127.0.0.1:4097/session/session_test/run/run_test/approval",
      headers: expect.any(Headers),
      body: {
        partId: "part_test",
        approved: false,
        whatToDoInstead: "use the read-only path",
      },
    }])
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token")
  })

  it("uses the authenticated abort endpoint for an explicit user stop", async () => {
    let request: { url: string; init?: RequestInit } | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        request = { url: String(input), init }
        return Response.json({ ok: true })
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    await expect(client.abortSession("session_test")).resolves.toBe(true)
    expect(request?.url).toBe("http://127.0.0.1:4097/session/session_test/abort")
    expect(request?.init?.method).toBe("POST")
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer secret-token")
  })

  it("loads the newest bounded message window instead of the oldest page", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        urls.push(url)
        if (/\/session\/session_test\?/.test(url)) {
          return Response.json({
            id: "session_test",
            cwd: process.cwd(),
            ts: 1,
            messageCount: 450,
            revision: 3,
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

    await client.getRecentMessages("session_test", 200)

    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain("limit=200")
    expect(urls[1]).toContain("offset=250")
  })
})

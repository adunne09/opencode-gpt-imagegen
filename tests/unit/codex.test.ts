import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  callViaCodexResponses,
  DEFAULT_MODEL,
  parseCodexConfigModel,
  parseImageGenerationResultFromSSE,
  resolveModel,
} from "../../src/codex"
import type { GenerateArgs } from "../../src/types"

// Build a ReadableStream that emits the given raw SSE text, as the fetch body would.
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function dataEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const imageDoneEvent = (result: string) =>
  dataEvent({ type: "response.output_item.done", item: { type: "image_generation_call", result } })

describe("parseImageGenerationResultFromSSE", () => {
  test("returns the result of the image_generation_call done event", async () => {
    const stream = sseStream(imageDoneEvent("BASE64IMAGE"))
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("BASE64IMAGE")
  })

  test("skips the [DONE] sentinel and unrelated events before the result", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.created" }),
      dataEvent({ type: "response.output_item.done", item: { type: "reasoning" } }),
      imageDoneEvent("RESULT"),
      "data: [DONE]\n\n",
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores non-JSON heartbeat lines", async () => {
    const stream = sseStream("data: ping\n\n", imageDoneEvent("RESULT"))
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores a done event whose item is not an image_generation_call", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.output_item.done", item: { type: "message", result: "not-an-image" } }),
      imageDoneEvent("RESULT"),
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores an image_generation_call whose result is not a string", async () => {
    const stream = sseStream(
      dataEvent({ type: "response.output_item.done", item: { type: "image_generation_call", result: 123 } }),
      imageDoneEvent("RESULT"),
    )
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("ignores an image_generation_call whose result is an empty string", async () => {
    // An empty result would decode to a 0-byte file and be reported as success; skip it.
    const stream = sseStream(imageDoneEvent(""), imageDoneEvent("RESULT"))
    expect(await parseImageGenerationResultFromSSE(stream)).toBe("RESULT")
  })

  test("throws when the stream contains no image_generation result", async () => {
    const stream = sseStream(dataEvent({ type: "response.created" }), "data: [DONE]\n\n")
    expect(parseImageGenerationResultFromSSE(stream)).rejects.toThrow(
      "no image_generation result returned by codex backend",
    )
  })
})

describe("callViaCodexResponses", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts the request to the codex endpoint and returns the parsed result", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response(imageDoneEvent("PARSED")))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok", accountId: "acct" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "high", size: "1024x1024" }
    const result = await callViaCodexResponses(auth, args, ["data:image/png;base64,AAA"], "test-model")

    expect(result).toBe("PARSED")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["ChatGPT-Account-Id"]).toBe("acct")
    expect(headers.originator).toBe("opencode")
    expect(headers.Accept).toBe("text/event-stream")
    expect(headers["Content-Type"]).toBe("application/json")

    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    // The instruction is load-bearing: it forces the backend to emit an image, not text.
    expect(body.instructions).toContain("image_generation")
    expect(body.tool_choice).toEqual({ type: "image_generation" })
    expect(body.tools[0]).toEqual({
      type: "image_generation",
      output_format: "png",
      quality: "high",
      size: "1024x1024",
    })
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "a cat" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ])
  })

  test("omits optional fields when size, accountId, and reference images are absent", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response(imageDoneEvent("PARSED")))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "auto" }
    await callViaCodexResponses(auth, args, [], "test-model")

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
    const body = JSON.parse(init.body as string)
    expect(body.tools[0]).not.toHaveProperty("size")
    expect(body.input[0].content).toEqual([{ type: "input_text", text: "a cat" }])
  })

  test("throws with the status and response body when the request fails", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response("upstream boom", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "auto" }
    expect(callViaCodexResponses(auth, args, [], "test-model")).rejects.toThrow(
      "codex responses request failed: 500 upstream boom",
    )
  })

  test("retries once with the default model when the configured model is unsupported", async () => {
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.model === "gpt-5.5") {
        return new Response(
          '{"detail":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}',
          {
            status: 400,
          },
        )
      }
      return new Response(imageDoneEvent("FALLBACK"))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "low" }
    expect(await callViaCodexResponses(auth, args, [], "gpt-5.5")).toBe("FALLBACK")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).model).toBe(DEFAULT_MODEL)
  })

  test("does not retry on unrelated 400 errors", async () => {
    const fetchMock = mock(async () => new Response("bad size", { status: 400 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const auth = { type: "oauth", access: "tok" } as const
    const args: GenerateArgs = { prompt: "a cat", out: "cat.png", quality: "low" }
    expect(callViaCodexResponses(auth, args, [], "gpt-5.5")).rejects.toThrow("400 bad size")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("resolveModel", () => {
  test("prefers GPT_IMAGEGEN_MODEL", async () => {
    expect(await resolveModel({ GPT_IMAGEGEN_MODEL: "env-model" }, "/nonexistent/config.toml")).toBe("env-model")
  })

  test("reads the top-level model from the codex config", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/imagegen-codex-config-${Date.now()}.toml`
    await Bun.write(path, 'model = "cfg-model"\n[profiles.x]\nmodel = "other"\n')
    expect(await resolveModel({}, path)).toBe("cfg-model")
  })

  test("falls back to the default when no config exists", async () => {
    expect(await resolveModel({}, "/nonexistent/config.toml")).toBe(DEFAULT_MODEL)
  })

  test("ignores model keys inside tables", () => {
    expect(parseCodexConfigModel('[profiles.x]\nmodel = "nested"\n')).toBeUndefined()
    expect(parseCodexConfigModel("model = 'single'")).toBe("single")
  })
})

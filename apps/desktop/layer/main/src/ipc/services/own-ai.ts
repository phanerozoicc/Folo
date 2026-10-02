import { net } from "electron"
import { getIpcContext, IpcMethod, IpcService } from "electron-ipc-decorator"

export interface OwnAiChatInput {
  baseURL: string
  apiKey: string
  model: string
  system?: string
  prompt: string
  temperature?: number
}

export interface OwnAiChatStreamMessage {
  role: "system" | "user" | "assistant"
  content:
    string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[]
}

export interface OwnAiChatStreamInput {
  baseURL: string
  apiKey: string
  model: string
  messages: OwnAiChatStreamMessage[]
  temperature?: number
  requestId: string
}

const REQUEST_TIMEOUT_MS = 300_000
const STREAM_EVENT = "own-ai:stream"
const STREAM_DONE_EVENT = "own-ai:stream-done"

/**
 * Resolve the OpenAI-compatible chat completions endpoint from a user supplied base URL.
 * Accepts forms like `https://host/v1`, `https://host/v1/` or a full endpoint URL.
 */
const resolveEndpoint = (baseURL: string) => {
  const trimmed = baseURL.trim().replace(/\/+$/, "")
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed
  }
  return `${trimmed}/chat/completions`
}

const postChatRequest = (
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) =>
  net.fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })

/**
 * Direct bridge to a user configured OpenAI-compatible endpoint.
 * Runs in the main process so renderer CORS policies never apply, and the
 * request never goes through the Folo API.
 */
export class OwnAiService extends IpcService {
  static override readonly groupName = "ownAi"

  @IpcMethod()
  async chatCompletion(input: OwnAiChatInput): Promise<{ content: string }> {
    const { baseURL, apiKey, model, system, prompt, temperature } = input
    if (!baseURL || !model) {
      throw new Error("OwnAI is not configured: baseURL and model are required")
    }

    const messages: { role: "system" | "user"; content: string }[] = []
    if (system) {
      messages.push({ role: "system", content: system })
    }
    messages.push({ role: "user", content: prompt })

    const response = await postChatRequest(
      resolveEndpoint(baseURL),
      apiKey,
      {
        model,
        messages,
        stream: false,
        ...(typeof temperature === "number" ? { temperature } : {}),
      },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )

    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 500)
      throw new Error(`OwnAI request failed (${response.status}): ${text || response.statusText}`)
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const { content } = data.choices?.[0]?.message ?? {}
    if (typeof content !== "string") {
      throw new TypeError("OwnAI response has no message content")
    }
    return { content }
  }

  /**
   * Streaming chat completion. Deltas are pushed to the requesting webContents
   * via `own-ai:stream` events keyed by requestId; the promise resolves with the
   * full text. `own-ai:stream-done` fires after success or failure — the whole
   * body is wrapped so *no* exception path can skip it (callers hang otherwise).
   */
  @IpcMethod()
  async chatCompletionStream(input: OwnAiChatStreamInput): Promise<{ content: string }> {
    const { baseURL, apiKey, model, messages, temperature, requestId } = input

    let sender: Electron.WebContents | undefined
    try {
      sender = getIpcContext().sender
    } catch {
      sender = undefined
    }
    let doneSent = false
    const push = (channel: string, ...args: unknown[]) => {
      if (sender && !sender.isDestroyed()) {
        sender.send(channel, requestId, ...args)
      }
    }
    const pushDone = (error: string | null) => {
      if (!doneSent) {
        doneSent = true
        push(STREAM_DONE_EVENT, error)
      }
    }

    try {
      if (!baseURL || !model) {
        throw new Error("OwnAI is not configured: baseURL and model are required")
      }

      let response: Response
      try {
        response = await postChatRequest(
          resolveEndpoint(baseURL),
          apiKey,
          {
            model,
            messages,
            stream: true,
            ...(typeof temperature === "number" ? { temperature } : {}),
          },
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        )
      } catch (error) {
        throw new Error(String(error).slice(0, 500))
      }

      if (!response.ok || !response.body) {
        const text = (await response.text().catch(() => "")).slice(0, 500)
        throw new Error(`OwnAI request failed (${response.status}): ${text || response.statusText}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let content = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.startsWith("data:")) continue

          const payload = line.slice(5).trim()
          if (payload === "[DONE]") continue

          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: unknown } }[]
            }
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === "string" && delta.length > 0) {
              content += delta
              push(STREAM_EVENT, delta)
            }
          } catch {
            // partial or non-JSON line; ignore
          }
        }
      }

      pushDone(null)
      return { content }
    } catch (error) {
      pushDone(String(error).slice(0, 500))
      throw error
    }
  }
}

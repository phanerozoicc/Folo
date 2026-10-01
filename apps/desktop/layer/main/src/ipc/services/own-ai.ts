import { net } from "electron"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

export interface OwnAiChatInput {
  baseURL: string
  apiKey: string
  model: string
  system?: string
  prompt: string
  temperature?: number
}

const REQUEST_TIMEOUT_MS = 120_000

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

    const response = await net.fetch(resolveEndpoint(baseURL), {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(typeof temperature === "number" ? { temperature } : {}),
      }),
    })

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
}

import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import { getEntry } from "@follow/store/entry/getter"
import { setTranslationPlanGateBypass } from "@follow/store/translation/store"

import { getAISettings, getOwnAISettings, isOwnAIEnabled } from "~/atoms/settings/ai"

import { ipcServices } from "./client"
import { handleAiTaskRequest, startOwnAITaskScheduler } from "./own-ai-tasks"

// Own AI generates translations on this device, so the free-plan gate must not block them.
setTranslationPlanGateBypass(() => isOwnAIEnabled())

export const isOwnAIRuntime = () =>
  isOwnAIEnabled() && typeof window !== "undefined" && !!(window as { electron?: unknown }).electron

export const languageLabel = (language: string) =>
  (ACTION_LANGUAGE_MAP as Record<string, { label: string }>)[language]?.label ?? language

export const stripHtml = (html: string, max = 160) => {
  if (!html) return ""
  if (!/<[a-z][\s\S]*>/i.test(html)) return html.slice(0, max)
  const doc = new DOMParser().parseFromString(html, "text/html")
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

export const chatCompletion = async (input: {
  system: string
  prompt: string
  temperature?: number
}) => {
  const ownAi = getOwnAISettings()
  const service = ipcServices?.ownAi
  if (!service) {
    throw new Error("OwnAI is only available in the desktop app")
  }
  const { content } = await service.chatCompletion({
    apiKey: ownAi.apiKey,
    baseURL: ownAi.baseURL,
    model: ownAi.model,
    system: input.system,
    prompt: input.prompt,
    temperature: input.temperature,
  })
  return content
}

// ---------------------------------------------------------------------------
// Entry summary
// ---------------------------------------------------------------------------

const MAX_SUMMARY_CHARS = 24_000

const summarizeEntry = async (input: {
  id: string
  language: string
  target: "content" | "readabilityContent"
}): Promise<string> => {
  const entry = getEntry(input.id) as Record<string, unknown> | null
  const rawSource =
    input.target === "readabilityContent"
      ? (entry?.readabilityContent ?? entry?.content)
      : entry?.content
  const text = stripHtml((rawSource as string) ?? "", MAX_SUMMARY_CHARS)

  if (!text) return ""

  return (
    await chatCompletion({
      temperature: 0.5,
      system:
        "You are a professional reading assistant. Summarize articles faithfully without adding commentary, advice or promotional tone.",
      prompt: `Summarize the following article in ${languageLabel(input.language)}. Keep the summary concise (3-6 sentences), cover the key points, and write it directly in ${languageLabel(input.language)}. Return ONLY the summary text.\n\n<article>\n${text}\n</article>`,
    })
  ).trim()
}

// ---------------------------------------------------------------------------
// Translation (NDJSON batch stream)
// ---------------------------------------------------------------------------

interface OwnAiTranslationBatchBody {
  ids: string[]
  language: string
  fields: string
  mode?: string
}

const MAX_TRANSLATION_CHARS = 60_000
const TRANSLATION_CHUNK_CHARS = 8_000
const TRANSLATION_CONCURRENCY = 4

const splitForTranslation = (text: string) => {
  if (text.length <= TRANSLATION_CHUNK_CHARS) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > TRANSLATION_CHUNK_CHARS) {
    let cut = rest.lastIndexOf("\n", TRANSLATION_CHUNK_CHARS)
    if (cut < TRANSLATION_CHUNK_CHARS / 2) {
      cut = rest.lastIndexOf(". ", TRANSLATION_CHUNK_CHARS)
    }
    if (cut < TRANSLATION_CHUNK_CHARS / 2) {
      cut = TRANSLATION_CHUNK_CHARS
    }
    chunks.push(rest.slice(0, cut + 1))
    rest = rest.slice(cut + 1)
  }
  if (rest.trim()) chunks.push(rest)
  return chunks
}

const translateText = async (text: string, lang: string, preserveHtml: boolean) => {
  const chunks = splitForTranslation(text)
  const system =
    "You are a professional translator. Translate faithfully, keep the original tone, format and formatting markers. Output ONLY the translation, without explanations, quotes or extra wrappers."

  const results: string[] = []
  for (const chunk of chunks) {
    const requirement = preserveHtml
      ? `The content is HTML. Translate only the human-readable text; keep every HTML tag, attribute, URL, code block and media element exactly as-is.`
      : `Translate the text as-is.`
    const prompt = `Translate the following content into ${lang}. ${requirement}\n\n<content>\n${chunk}\n</content>`
    const content = await chatCompletion({ temperature: 0.2, system, prompt })
    results.push(
      content
        .trim()
        .replace(/^<content>/i, "")
        .replace(/<\/content>$/i, "")
        .trim(),
    )
  }
  return results.join("")
}

const isHtmlField = (field: string) => field === "content" || field === "readabilityContent"

const translateField = async (
  entryId: string,
  field: string,
  lang: string,
): Promise<string | null> => {
  const entry = getEntry(entryId) as Record<string, unknown> | null
  if (!entry) return null

  const raw = isHtmlField(field)
    ? (((field === "readabilityContent" ? entry.readabilityContent : entry.content) as
        string | undefined) ??
      (entry.content as string | undefined) ??
      "")
    : ((entry[field] as string | undefined) ?? "")
  const source = typeof raw === "string" ? raw : ""
  if (!source) return null

  const translated = await translateText(
    source.slice(0, MAX_TRANSLATION_CHARS),
    lang,
    isHtmlField(field),
  )
  return translated || null
}

const translateBatchNDJSON = async (request: OwnAiTranslationBatchBody): Promise<Response> => {
  const { ids, language, fields } = request
  const lang = languageLabel(language)
  const fieldList = String(fields)
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const queue = [...ids]
      const worker = async () => {
        while (queue.length > 0) {
          const id = queue.shift()!
          const data: Record<string, string> = {}
          for (const field of fieldList) {
            try {
              const translated = await translateField(id, field, lang)
              if (translated) data[field] = translated
            } catch (error) {
              console.error(`[own-ai] translate ${field} failed for entry ${id}:`, error)
            }
          }
          controller.enqueue(encoder.encode(`${JSON.stringify({ id, data })}\n`))
        }
      }

      const concurrency = Math.min(TRANSLATION_CONCURRENCY, Math.max(queue.length, 1))
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      controller.close()
    },
  })

  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } })
}

// ---------------------------------------------------------------------------
// Timeline AI sort: re-rank a fetched page locally
// ---------------------------------------------------------------------------

const RERANK_MAX_ENTRIES = 40

const rerankEntries = async <T>(entries: T[]): Promise<T[]> => {
  if (entries.length < 3) return entries

  const items = entries.slice(0, RERANK_MAX_ENTRIES)
  const lines = items.map((item, index) => {
    const e = item as {
      entries?: { title?: string; publishedAt?: string; description?: string }
      feeds?: { title?: string }
    }
    const title = e.entries?.title ?? ""
    const feedTitle = e.feeds?.title ?? ""
    const description = stripHtml(e.entries?.description ?? "")
    const publishedAt = e.entries?.publishedAt
      ? ` | ${String(e.entries.publishedAt).slice(0, 10)}`
      : ""
    return `[${index}] ${feedTitle} | ${title}${publishedAt} — ${description}`
  })

  const preference =
    getAISettings().aiTimelinePrompt?.trim() ||
    "Rank by likely relevance and interest: significance of the news, depth of the content, and match with the user's subscriptions."

  const response = await chatCompletion({
    temperature: 0.2,
    system:
      "You rank RSS feed entries for a user. Respond with ONLY a JSON array of the item numbers, most relevant first, e.g. [3,0,2,1]. Every number must appear exactly once. No explanation.",
    prompt: `User preference: ${preference}\n\nEntries:\n${lines.join("\n")}\n\nReturn the JSON array now.`,
  })

  const match = response.match(/\[[\d\s,]*\]/)
  if (!match) return entries

  const order = JSON.parse(match[0]) as unknown[]
  const seen = new Set<number>()
  const head: number[] = []
  for (const n of order) {
    if (typeof n === "number" && n >= 0 && n < items.length && !seen.has(n)) {
      seen.add(n)
      head.push(n)
    }
  }
  const tail = items.map((_, index) => index).filter((index) => !seen.has(index))
  const ranked = [...head, ...tail].map((index) => items[index]!)
  return [...ranked, ...entries.slice(RERANK_MAX_ENTRIES)]
}

const jsonOk = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const ownAIModelConfig = () => {
  const model = getOwnAISettings().model
  return {
    code: 0,
    data: {
      defaultModel: model,
      availableModels: [model],
      availableModelsMenu: [{ label: model, value: model }],
      rateLimit: {
        maxTokens: Number.POSITIVE_INFINITY,
        currentTokens: 0,
        remainingTokens: Number.POSITIVE_INFINITY,
        windowDuration: 86_400_000,
        windowResetTime: Date.now() + 86_400_000,
      },
      attachmentLimits: {
        maxFiles: 5,
        remainingFiles: 5,
        windowDuration: 86_400_000,
        windowResetTime: Date.now() + 86_400_000,
      },
      usage: { total: 0, used: 0, remaining: 0, resetAt: new Date().toISOString() },
      freeQuota: {
        shouldCheckDailyLimit: false,
        remainingRequests: 0,
        remainingMonthlyRequests: 0,
        role: "own-ai",
        dailyLimit: 0,
        monthlyLimit: 0,
      },
    },
  }
}

const entriesAiSortPath = (url: URL) => {
  if (url.pathname.replace(/\/+$/, "") !== "/entries") return null
  return url
}

// ---------------------------------------------------------------------------
// Fetch-level interceptor: every FollowAPI request passes through here.
// NOTE: the SDK exposes api modules as Proxy objects whose get trap always
// builds the original route function, so patching methods on them does NOT
// work — intercepting HTTP requests is the only reliable seam.
// ---------------------------------------------------------------------------

export const interceptOwnAIRequest = async (
  request: Request,
  passthrough: (request: Request) => Promise<Response>,
): Promise<Response | null> => {
  if (!isOwnAIRuntime()) return null

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/"

  // GET /ai/summary?id=&language=&target=
  if (request.method === "GET" && pathname === "/ai/summary") {
    const id = url.searchParams.get("id") ?? ""
    const language = url.searchParams.get("language") ?? "en"
    const target = (url.searchParams.get("target") ?? "content") as "content" | "readabilityContent"
    console.info("[own-ai] serving /ai/summary locally", id)
    try {
      const text = await summarizeEntry({ id, language, target })
      return jsonOk({ code: 0, data: text })
    } catch (error) {
      console.error("[own-ai] summary failed:", error)
      return jsonOk({ code: 500, data: "" })
    }
  }

  // POST /ai/translation/batch
  if (request.method === "POST" && pathname === "/ai/translation/batch") {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as OwnAiTranslationBatchBody | null
    if (!body) return null
    console.info("[own-ai] serving /ai/translation/batch locally", body.ids?.length, "entries")
    return translateBatchNDJSON(body)
  }

  // GET /ai/chat/config — expose only the user's own model
  if (request.method === "GET" && pathname === "/ai/chat/config") {
    console.info("[own-ai] serving /ai/chat/config locally (own model only)")
    return jsonOk(ownAIModelConfig())
  }

  // POST /entries with aiSort — fetch without the flag, re-rank locally
  const entriesUrl = entriesAiSortPath(url)
  if (request.method === "POST" && entriesUrl) {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as (Record<string, unknown> & { aiSort?: boolean }) | null
    if (!body?.aiSort) return null

    const { aiSort: _aiSort, ...restBody } = body
    const strippedRequest = new Request(entriesUrl.toString(), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(restBody),
    })
    const original = await passthrough(strippedRequest)
    const payload = (await original
      .clone()
      .json()
      .catch(() => null)) as { code: number; data: unknown[] } | null
    if (!payload || !Array.isArray(payload.data)) return original

    console.info("[own-ai] re-ranking", payload.data.length, "entries locally")
    try {
      payload.data = await rerankEntries(payload.data)
    } catch (error) {
      console.error("[own-ai] local timeline sort failed, keeping original order:", error)
      return original
    }
    return jsonOk(payload)
  }

  // /ai/task* — local task store
  if (pathname === "/ai/task" || pathname.startsWith("/ai/task/")) {
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? undefined
        : await request
            .clone()
            .json()
            .catch(() => undefined)
    const response = await handleAiTaskRequest({
      method: request.method,
      pathname,
      body,
    })
    if (response) {
      console.info("[own-ai] served /ai/task route locally:", request.method, pathname)
      return response
    }
  }

  return null
}

// Scheduler for local AI tasks must start with the app (idempotent).
startOwnAITaskScheduler()

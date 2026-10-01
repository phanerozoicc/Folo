import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import { getEntry } from "@follow/store/entry/getter"
import { setTranslationPlanGateBypass } from "@follow/store/translation/store"

import { getOwnAISettings, isOwnAIEnabled } from "~/atoms/settings/ai"

import { ipcServices } from "./client"

// Own AI generates translations on this device, so the free-plan gate must not block them.
setTranslationPlanGateBypass(() => isOwnAIEnabled())

interface OwnAiSummaryInput {
  id: string
  language: string
  target: "content" | "readabilityContent"
}

interface OwnAiTranslationBatchInput {
  ids: string[]
  language: string
  fields: string
  mode?: string
}

const MAX_SUMMARY_CHARS = 24_000
const MAX_TRANSLATION_CHARS = 60_000
const TRANSLATION_CHUNK_CHARS = 8_000
const TRANSLATION_CONCURRENCY = 4

const isElectronRuntime = () =>
  typeof window !== "undefined" && !!(window as { electron?: unknown }).electron

const languageLabel = (language: string) =>
  (ACTION_LANGUAGE_MAP as Record<string, { label: string }>)[language]?.label ?? language

const isHtmlField = (field: string) => field === "content" || field === "readabilityContent"

const htmlToText = (html: string) => {
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim()
}

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

const chatCompletion = async (input: { system: string; prompt: string; temperature: number }) => {
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

const summarizeWithOwnAI = async (input: OwnAiSummaryInput): Promise<{ data: string }> => {
  const entry = getEntry(input.id)
  const rawSource =
    input.target === "readabilityContent"
      ? (entry?.readabilityContent ?? entry?.content)
      : entry?.content
  const text = htmlToText(rawSource ?? "").slice(0, MAX_SUMMARY_CHARS)

  if (!text) {
    return { data: "" }
  }

  const lang = languageLabel(input.language)
  const content = await chatCompletion({
    temperature: 0.5,
    system:
      "You are a professional reading assistant. Summarize articles faithfully without adding commentary, advice or promotional tone.",
    prompt: `Summarize the following article in ${lang}. Keep the summary concise (3-6 sentences), cover the key points, and write it directly in ${lang}. Return ONLY the summary text.\n\n<article>\n${text}\n</article>`,
  })

  return { data: content.trim() }
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

const translateFieldWithOwnAI = async (
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

  const capped = source.slice(0, MAX_TRANSLATION_CHARS)
  const translated = await translateText(capped, lang, isHtmlField(field))
  return translated || null
}

const translateBatchWithOwnAI = async (request: OwnAiTranslationBatchInput): Promise<Response> => {
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
              const translated = await translateFieldWithOwnAI(id, field, lang)
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

/**
 * Route entry summary and translation to the device-local AI backend when enabled.
 * Everything else keeps talking to the Folo API as usual.
 */
export function patchFollowApiWithOwnAI(api: { ai: Record<string, unknown> }) {
  const { ai } = api

  const originalSummary = ai.summary as (input: OwnAiSummaryInput) => Promise<unknown>
  ai.summary = async (input: OwnAiSummaryInput) => {
    if (!isOwnAIEnabled() || !isElectronRuntime()) {
      return originalSummary.call(ai, input)
    }
    return summarizeWithOwnAI(input)
  }

  const originalTranslationBatch = ai.translationBatch as (
    input: OwnAiTranslationBatchInput,
  ) => Promise<Response>
  ai.translationBatch = async (input: OwnAiTranslationBatchInput) => {
    if (!isOwnAIEnabled() || !isElectronRuntime()) {
      return originalTranslationBatch.call(ai, input)
    }
    return translateBatchWithOwnAI(input)
  }
}

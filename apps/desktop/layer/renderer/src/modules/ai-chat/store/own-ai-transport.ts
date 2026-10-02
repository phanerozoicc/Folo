import type { UIMessageChunk } from "ai"
import { HttpChatTransport } from "ai"

import { getAISettings, getOwnAISettings } from "~/atoms/settings/ai"
import { ipcServices } from "~/lib/client"
import { recordOwnAiUsage } from "~/lib/own-ai-usage"

import { AIPersistService } from "../services"
import type { CreateChatTransportOptions } from "./transport"
import type { BizUIMessage } from "./types"

const STREAM_EVENT = "own-ai:stream"
const STREAM_DONE_EVENT = "own-ai:stream-done"

interface OwnAiStreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

const BASE_SYSTEM_PROMPT =
  "You are Folo's reading assistant. Answer helpfully and concisely, in the language the user writes in."

type ChatPart = BizUIMessage["parts"][number]

type OpenAiContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

type OpenAiMessage = {
  role: "system" | "user" | "assistant"
  content: string | OpenAiContentPart[]
}

const toOpenAiMessages = (messages: BizUIMessage[], systemPrompt: string): OpenAiMessage[] => {
  const result: OpenAiMessage[] = [{ role: "system", content: systemPrompt }]

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue

    const textParts: string[] = []
    const imageParts: OpenAiContentPart[] = []

    for (const part of message.parts as ChatPart[]) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        textParts.push(part.text)
      } else if (
        part.type === "file" &&
        "url" in part &&
        "mediaType" in part &&
        typeof part.url === "string" &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/")
      ) {
        imageParts.push({ type: "image_url", image_url: { url: part.url } })
      }
      // reasoning/tool/step parts are intentionally skipped: local chat has no tool runtime
    }

    const text = textParts.join("\n").trim()
    if (!text && imageParts.length === 0) continue

    if (message.role === "user" && imageParts.length > 0) {
      const content: OpenAiContentPart[] = []
      if (text) content.push({ type: "text", text })
      content.push(...imageParts)
      result.push({ role: "user", content })
    } else {
      result.push({ role: message.role, content: text })
    }
  }

  return result
}

/**
 * Chat transport that talks directly to the user's Own AI endpoint.
 * Streams plain-text deltas from the main process and converts them into
 * UIMessageChunks compatible with the AI SDK chat runtime.
 */
export class OwnAiChatTransport extends HttpChatTransport<BizUIMessage> {
  private readonly ownOptions: CreateChatTransportOptions

  constructor(options: CreateChatTransportOptions & Record<string, unknown>) {
    super({ api: "https://own-ai.invalid/chat" } as never)
    this.ownOptions = options
  }

  /** Never used: sendMessages is fully overridden and never fetches an HTTP response. */
  protected override processResponseStream(): ReadableStream<UIMessageChunk> {
    return this.errorStream("Own AI transport does not support HTTP response streaming")
  }

  override async sendMessages({
    messages,
    abortSignal,
  }: {
    messages: BizUIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    const ownAi = getOwnAISettings()
    const service = ipcServices?.ownAi

    if (!service) {
      return this.errorStream("Own AI chat is only available in the desktop app")
    }

    const systemPrompt = [BASE_SYSTEM_PROMPT, getAISettings().personalizePrompt]
      .filter(Boolean)
      .join("\n\n")

    const requestId = `own-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ipc = (typeof window !== "undefined" ? window.electron?.ipcRenderer : undefined) as
      | {
          on: (channel: string, listener: (...args: any[]) => void) => void
          off?: (channel: string, listener: (...args: any[]) => void) => void
          removeListener: (channel: string, listener: (...args: any[]) => void) => void
        }
      | undefined

    const chatMessages = toOpenAiMessages(messages, systemPrompt)
    const onlyUserMessage = messages.filter((m) => m.role === "user").length === 1

    let finished = false
    let textId = ""
    let chatUsage: OwnAiStreamUsage | null = null

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        if (!ipc) {
          controller.enqueue({
            type: "error",
            errorText: "Own AI chat is only available in the desktop app",
          } as UIMessageChunk)
          controller.close()
          finished = true
          return
        }

        controller.enqueue({ type: "start" } as UIMessageChunk)
        controller.enqueue({ type: "start-step" } as UIMessageChunk)
        textId = `text-${Date.now()}`
        controller.enqueue({ type: "text-start", id: textId } as UIMessageChunk)

        const onDelta = (electronEvent: unknown, eventRequestId: string, delta: unknown) => {
          // ipcRenderer.on listeners receive (event, ...args); first arg is the Electron event.
          if (eventRequestId !== requestId || finished) return
          if (typeof delta === "string" && delta.length > 0) {
            window.clearTimeout(stallTimer)
            controller.enqueue({ type: "text-delta", id: textId, delta } as UIMessageChunk)
          }
        }

        // Never leave the chat spinning forever if the done event is lost.
        const stallTimer = window.setTimeout(() => {
          if (finished) return
          finished = true
          cleanup()
          controller.enqueue({
            type: "error",
            errorText: "Own AI stream stalled with no output for 90s",
          } as UIMessageChunk)
          controller.close()
        }, 90_000)

        const cleanup = () => {
          window.clearTimeout(stallTimer)
          try {
            ipc.removeListener(STREAM_EVENT, onDelta)
            ipc.removeListener(STREAM_DONE_EVENT, onDone)
          } catch {
            // webContents gone
          }
        }

        const onDone = (electronEvent: unknown, eventRequestId: string, errorMessage: unknown) => {
          if (eventRequestId !== requestId || finished) return
          finished = true
          cleanup()

          if (abortSignal?.aborted) {
            controller.close()
            return
          }

          if (errorMessage) {
            controller.enqueue({ type: "error", errorText: String(errorMessage) } as UIMessageChunk)
            controller.close()
            return
          }

          controller.enqueue({ type: "text-end", id: textId } as UIMessageChunk)
          controller.enqueue({ type: "finish-step" } as UIMessageChunk)
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              modelUsed: ownAi.model,
              providerType: "byok",
              provider: "own-ai",
              totalTokens: chatUsage?.total_tokens,
              outputTokens: chatUsage?.completion_tokens,
            },
          } as UIMessageChunk)
          controller.close()

          void this.maybeGenerateTitle(messages, onlyUserMessage)
        }

        const onIpcResult = (result: { content: string; usage: OwnAiStreamUsage | null }) => {
          recordOwnAiUsage({
            feature: "chat",
            model: ownAi.model,
            promptTokens: result.usage?.prompt_tokens ?? 0,
            completionTokens: result.usage?.completion_tokens ?? 0,
            totalTokens:
              result.usage?.total_tokens ??
              (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0),
          })
          chatUsage = result.usage
        }

        ipc.on(STREAM_EVENT, onDelta)
        ipc.on(STREAM_DONE_EVENT, onDone)

        service
          .chatCompletionStream({
            apiKey: ownAi.apiKey,
            baseURL: ownAi.baseURL,
            model: ownAi.model,
            messages: chatMessages,
            requestId,
          })
          .then((result) => {
            onIpcResult(result)
            // The done event drives stream finalization; if it somehow never
            // arrived but the IPC promise resolved, finalize here instead.
            if (!finished) {
              onDone(undefined, requestId, null)
            }
          })
          .catch(() => {
            // errors also arrive via the done event; keep this guard to avoid unhandled rejections
          })

        abortSignal?.addEventListener(
          "abort",
          () => {
            if (!finished) {
              finished = true
              try {
                ipc.removeListener(STREAM_EVENT, onDelta)
                ipc.removeListener(STREAM_DONE_EVENT, onDone)
              } catch {
                // ignore
              }
              controller.close()
            }
          },
          { once: true },
        )
      },
      cancel: () => {
        finished = true
      },
    })

    return stream
  }

  private async maybeGenerateTitle(messages: BizUIMessage[], onlyUserMessage: boolean) {
    if (!onlyUserMessage) return

    const { titleHandler } = this.ownOptions
    if (!titleHandler) return

    try {
      const ownAi = getOwnAISettings()
      const service = ipcServices?.ownAi
      if (!service) return

      const firstUserText =
        messages
          .find((m) => m.role === "user")
          ?.parts.filter((part) => part.type === "text")
          .map((part) => ("text" in part ? part.text : ""))
          .join(" ")
          .slice(0, 500) ?? ""
      if (!firstUserText) return

      const titleModel = ownAi.fastModel?.trim() || ownAi.model
      const { content, usage } = await service.chatCompletion({
        apiKey: ownAi.apiKey,
        baseURL: ownAi.baseURL,
        model: titleModel,
        system:
          "Generate a concise chat title (max 20 characters) in the language of the text. Output ONLY the title.",
        prompt: firstUserText,
        temperature: 0.3,
      })
      recordOwnAiUsage({
        feature: "title",
        model: titleModel,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens:
          usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      })

      const title = content
        .trim()
        .replace(/^["'「『]|["'」』]$/g, "")
        .slice(0, 40)
      if (!title) return

      const shouldHandle = titleHandler.shouldHandle?.() ?? true
      if (!shouldHandle) return

      titleHandler.onTitleChange?.(title)

      const { persist, chatId } = titleHandler
      const shouldPersist = persist === undefined ? true : persist
      if (shouldPersist && chatId) {
        await AIPersistService.updateSessionTitle(chatId, title)
      }
    } catch (error) {
      console.error("[own-ai] title generation failed:", error)
    }
  }

  private errorStream(errorText: string): ReadableStream<UIMessageChunk> {
    let pushed = false
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        if (pushed) return
        pushed = true
        controller.enqueue({ type: "error", errorText } as UIMessageChunk)
        controller.close()
      },
    })
  }
}

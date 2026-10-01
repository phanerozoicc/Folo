import { getStorageNS } from "@follow/utils/ns"

import { getAISettings, getOwnAISettings, isOwnAIEnabled } from "~/atoms/settings/ai"

import { ipcServices } from "./client"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const isOwnAIRuntime = () =>
  isOwnAIEnabled() && typeof window !== "undefined" && !!(window as { electron?: unknown }).electron

const stripHtml = (html: string, max = 160) => {
  if (!html) return ""
  if (!/<[a-z][\s\S]*>/i.test(html)) return html.slice(0, max)
  const doc = new DOMParser().parseFromString(html, "text/html")
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

const chatCompletion = async (input: { system: string; prompt: string; temperature?: number }) => {
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
// Timeline AI sort: re-rank a fetched page locally instead of asking the server
// ---------------------------------------------------------------------------

type EntriesListParams = { aiSort?: boolean; [key: string]: unknown }

const RERANK_MAX_ENTRIES = 40

const rerankEntries = async <T>(entries: T[]): Promise<T[]> => {
  if (entries.length < 3) return entries

  const items = entries.slice(0, RERANK_MAX_ENTRIES)
  const lines = items.map((item, index) => {
    const e = item as {
      entries?: { title?: string; publishedAt?: string }
      feeds?: { title?: string }
    }
    const title = e.entries?.title ?? ""
    const feedTitle = e.feeds?.title ?? ""
    const description = stripHtml(
      (e.entries as { description?: string } | undefined)?.description ?? "",
    )
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
  const valid = order.filter(
    (n): n is number => typeof n === "number" && n >= 0 && n < items.length,
  )
  const seen = new Set<number>()
  const head: number[] = []
  for (const n of valid) {
    if (!seen.has(n)) {
      seen.add(n)
      head.push(n)
    }
  }
  const tail = items.map((_, index) => index).filter((index) => !seen.has(index))
  const ranked = [...head, ...tail].map((index) => items[index]!)
  return [...ranked, ...entries.slice(RERANK_MAX_ENTRIES)]
}

const patchEntriesListWithOwnAI = (entriesApi: Record<string, unknown>) => {
  const originalList = entriesApi.list as (
    params: EntriesListParams,
    config?: unknown,
  ) => Promise<{ code: number; data: unknown }>

  entriesApi.list = async (params: EntriesListParams, config?: unknown) => {
    if (!params?.aiSort || !isOwnAIRuntime()) {
      return originalList.call(entriesApi, params, config)
    }

    const { aiSort: _aiSort, ...restParams } = params
    const result = await originalList.call(entriesApi, restParams, config)

    try {
      if (Array.isArray(result.data)) {
        result.data = await rerankEntries(result.data)
      }
    } catch (error) {
      console.error("[own-ai] local timeline sort failed, keeping original order:", error)
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Local AI tasks (daily report etc.): the task system runs on this device
// ---------------------------------------------------------------------------

type LocalTaskSchedule =
  | { type: "once"; date: string }
  | { type: "daily"; timeOfDay: string }
  | { type: "weekly"; dayOfWeek: number; timeOfDay: string }
  | { type: "monthly"; dayOfMonth: number; timeOfDay: string }

type LocalTask = {
  id: string
  name: string
  prompt: string
  isEnabled: boolean
  schedule: LocalTaskSchedule
  options: { notifyChannels?: string[] }
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  runCount: number
  lastResult: string | null
  lastError: string | null
}

const TASKS_KEY = getStorageNS("own-ai-tasks")

const loadTasks = (): LocalTask[] => {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) ?? "[]") as LocalTask[]
  } catch {
    return []
  }
}

const saveTasks = (tasks: LocalTask[]) => {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks))
}

const toLocalTask = (input: {
  name: string
  prompt: string
  isEnabled?: boolean
  schedule: LocalTaskSchedule
  options?: { notifyChannels?: string[] }
}): LocalTask => {
  const now = new Date().toISOString()
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    prompt: input.prompt,
    isEnabled: input.isEnabled ?? true,
    schedule: input.schedule,
    options: input.options ?? {},
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: computeNextRunAt(input.schedule),
    runCount: 0,
    lastResult: null,
    lastError: null,
  }
}

const timeParts = (iso: string) => {
  const d = new Date(iso)
  return { hours: d.getHours(), minutes: d.getMinutes() }
}

const atTime = (base: Date, hours: number, minutes: number) => {
  const d = new Date(base)
  d.setHours(hours, minutes, 0, 0)
  return d
}

export const computeNextRunAt = (schedule: LocalTaskSchedule, from = new Date()): string => {
  if (schedule.type === "once") return schedule.date

  const { hours, minutes } = timeParts(schedule.timeOfDay)
  const next = new Date(from)
  next.setSeconds(0, 0)

  if (schedule.type === "daily") {
    const today = atTime(next, hours, minutes)
    return (today > next ? today : new Date(today.getTime() + 86_400_000)).toISOString()
  }

  if (schedule.type === "weekly") {
    for (let i = 0; i < 8; i++) {
      const candidate = atTime(new Date(next.getTime() + i * 86_400_000), hours, minutes)
      if (candidate.getDay() === schedule.dayOfWeek && candidate > next)
        return candidate.toISOString()
    }
    return next.toISOString()
  }

  // monthly
  for (let i = 0; i < 31; i++) {
    const candidate = new Date(next)
    candidate.setDate(candidate.getDate() + i)
    candidate.setHours(hours, minutes, 0, 0)
    const day =
      candidate.getDate() === schedule.dayOfMonth
        ? candidate
        : new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0, hours, minutes)
    if (day > next) return day.toISOString()
  }
  return next.toISOString()
}

const isTaskDue = (task: LocalTask, now = new Date()): boolean => {
  if (!task.isEnabled) return false

  if (task.schedule.type === "once") {
    return !task.lastRunAt && new Date(task.schedule.date) <= now
  }

  const { hours, minutes } = timeParts(task.schedule.timeOfDay)
  const scheduledToday = atTime(now, hours, minutes)
  if (scheduledToday > now) return false

  if (task.lastRunAt && new Date(task.lastRunAt) >= scheduledToday) return false

  if (task.schedule.type === "weekly") {
    return now.getDay() === task.schedule.dayOfWeek
  }
  if (task.schedule.type === "monthly") {
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    return now.getDate() === Math.min(task.schedule.dayOfMonth, lastDayOfMonth)
  }
  return true
}

const collectRecentEntriesDigest = async (limit = 40): Promise<string> => {
  const { followApi } = await import("./api-client")
  const res = await followApi.entries.list({ limit } as never)
  const entries = (Array.isArray(res?.data) ? res.data : []) as {
    entries?: { title?: string; description?: string; publishedAt?: string }
    feeds?: { title?: string }
  }[]

  return entries
    .map((item, index) => {
      const feedTitle = item.feeds?.title ?? ""
      const title = item.entries?.title ?? ""
      const publishedAt = item.entries?.publishedAt
        ? String(item.entries.publishedAt).slice(0, 10)
        : ""
      const description = stripHtml(item.entries?.description ?? "")
      return `${index + 1}. [${feedTitle}] ${title} (${publishedAt}) — ${description}`
    })
    .join("\n")
}

const runTask = async (task: LocalTask): Promise<void> => {
  const tasks = loadTasks()
  const current = tasks.find((t) => t.id === task.id)
  if (!current) return

  try {
    const digest = await collectRecentEntriesDigest()
    const content = await chatCompletion({
      temperature: 0.5,
      system:
        "You are the user's personal RSS reading assistant. Fulfil the user's request based on the recent entries provided. Respond in the same language as the user's request. Markdown is supported.",
      prompt: `${task.prompt}\n\n---\nRecent entries:\n${digest || "(no recent entries)"}`,
    })

    current.lastResult = content
    current.lastError = null
    current.runCount += 1
  } catch (error) {
    current.lastError = String(error).slice(0, 500)
  }

  current.lastRunAt = new Date().toISOString()
  if (current.schedule.type === "once") {
    current.isEnabled = false
    current.nextRunAt = null
  } else {
    current.nextRunAt = computeNextRunAt(current.schedule)
  }
  current.updatedAt = current.lastRunAt

  saveTasks(tasks.map((t) => (t.id === current.id ? current : t)))

  if (current.lastResult) {
    try {
      const notification = new Notification(current.name, {
        body: current.lastResult.replace(/\s+/g, " ").slice(0, 120),
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch {
      // notifications unavailable; result stays visible in the task list
    }
  }
}

let schedulerStarted = false
export const startOwnAITaskScheduler = () => {
  if (schedulerStarted) return
  schedulerStarted = true

  const tick = () => {
    if (!isOwnAIRuntime()) return
    for (const task of loadTasks()) {
      if (isTaskDue(task)) {
        void runTask(task)
      }
    }
  }

  window.setInterval(tick, 60_000)
  window.setTimeout(tick, 15_000)
}

const patchAiTaskWithOwnAI = (aiTaskApi: Record<string, unknown>) => {
  aiTaskApi.list = async () => {
    return { code: 0, data: loadTasks() }
  }
  aiTaskApi.get = async ({ id }: { id: string }) => {
    const task = loadTasks().find((t) => t.id === id)
    if (!task) throw new Error(`Task ${id} not found`)
    return { code: 0, data: task }
  }
  aiTaskApi.create = async (input: {
    name: string
    prompt: string
    isEnabled?: boolean
    schedule: LocalTaskSchedule
    options?: { notifyChannels?: string[] }
  }) => {
    const task = toLocalTask(input)
    const tasks = loadTasks()
    tasks.unshift(task)
    saveTasks(tasks)
    return { code: 0, data: task }
  }
  aiTaskApi.update = async (input: {
    id: string
    name?: string
    prompt?: string
    isEnabled?: boolean
    schedule?: LocalTaskSchedule
    options?: { notifyChannels?: string[] }
  }) => {
    const tasks = loadTasks()
    const task = tasks.find((t) => t.id === input.id)
    if (!task) throw new Error(`Task ${input.id} not found`)
    if (input.name !== undefined) task.name = input.name
    if (input.prompt !== undefined) task.prompt = input.prompt
    if (input.isEnabled !== undefined) task.isEnabled = input.isEnabled
    if (input.options !== undefined) task.options = input.options
    if (input.schedule !== undefined) {
      task.schedule = input.schedule
      task.nextRunAt = task.isEnabled ? computeNextRunAt(input.schedule) : null
    }
    task.updatedAt = new Date().toISOString()
    saveTasks(tasks)
    return { code: 0, data: task }
  }
  aiTaskApi.delete = async ({ id }: { id: string }) => {
    saveTasks(loadTasks().filter((t) => t.id !== id))
    return { code: 0, data: null }
  }
  aiTaskApi.testRun = async ({ id }: { id: string }) => {
    const task = loadTasks().find((t) => t.id === id)
    if (!task) throw new Error(`Task ${id} not found`)
    await runTask(task)
    const updated = loadTasks().find((t) => t.id === id)
    return {
      code: 0,
      data: {
        taskId: id,
        result: updated?.lastResult ?? undefined,
        error: updated?.lastError ?? undefined,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function patchOwnAIFeatures(api: {
  entries: Record<string, unknown>
  aiTask: Record<string, unknown>
}) {
  patchEntriesListWithOwnAI(api.entries)
  patchAiTaskWithOwnAI(api.aiTask)
  startOwnAITaskScheduler()
}
